import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';

export function installPlotInteractionMethods(TargetClass) {
    const proto = TargetClass.prototype;
    const PlotManager = TargetClass;
const escapeHtml = (text) => String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const formatPlaceholderHint = (key) => {
    switch (i18n.currentLang) {
        case 'fr':
            if (key === 'multiSelectHint') {
                return '<strong>Ctrl/Cmd-clic</strong> pour <strong>sélectionner plusieurs variables</strong> avant de les faire glisser.';
            }
            if (key === 'legendHint') {
                return 'Cliquez sur les <strong>éléments de légende</strong> pour <strong>afficher</strong> ou <strong>masquer</strong> les traces. <strong>Maj+clic</strong> pour <strong>supprimer la trace</strong>.';
            }
            break;
        case 'es':
            if (key === 'multiSelectHint') {
                return '<strong>Ctrl/Cmd-clic</strong> para <strong>seleccionar varias variables</strong> antes de arrastrarlas.';
            }
            if (key === 'legendHint') {
                return 'Haz clic en la <strong>leyenda</strong> para <strong>mostrar</strong> u <strong>ocultar</strong> trazas. <strong>Mayús+clic</strong> para <strong>eliminar la traza</strong>.';
            }
            break;
        case 'it':
            if (key === 'multiSelectHint') {
                return '<strong>Ctrl/Cmd-clic</strong> per <strong>selezionare più variabili</strong> prima di trascinarle.';
            }
            if (key === 'legendHint') {
                return 'Clicca sulla <strong>legenda</strong> per <strong>mostrare</strong> o <strong>nascondere</strong> le tracce. <strong>Maiusc+clic</strong> per <strong>rimuovere la traccia</strong>.';
            }
            break;
        default:
            if (key === 'multiSelectHint') {
                return '<strong>Ctrl/Cmd-click</strong> to <strong>multi-select variables</strong> before dragging.';
            }
            if (key === 'legendHint') {
                return 'Click <strong>legend items</strong> to <strong>show</strong> or <strong>hide</strong> traces. <strong>Shift+Click</strong> to <strong>remove trace</strong>.';
            }
            break;
    }
    return escapeHtml(i18n.t(key));
};

proto._onRelayout = function(sourcePanelId, eventData) {
    const update = this._xAxisUpdateFromRelayout(eventData);
    if (!update) return;
    const plot = this.plots.get(sourcePanelId);

    if (this._syncing && sourcePanelId !== this._syncSourcePanelId) {
        return;
    }

    if (plot?._relayoutLiveOnly) {
        this._onRelayouting(sourcePanelId, eventData);
        return;
    }

    if (plot?.mode === 'timeseries') {
        const autorangeRequested = update['xaxis.autorange'] === true || eventData?.['yaxis.autorange'] === true;
        if (autorangeRequested) {
            this._autoScalePlot(sourcePanelId, plot);
        } else {
            const visibleRange = Array.isArray(update['xaxis.range']) ? update['xaxis.range'] : null;
            this._refreshTimeseriesVisuals(sourcePanelId, plot, visibleRange);
        }
        if (plot?.cursors?.enabled) this._renderCursorOverlay(plot);
    }

    if (!this.syncAxes) return;

    if (this._syncing) {
        if (sourcePanelId === this._syncSourcePanelId) {
            this._pendingAxisSync = { sourcePanelId, update };
        }
        return;
    }

    this._syncXAxisUpdate(sourcePanelId, update);
};

proto._onRelayouting = function(sourcePanelId, eventData) {
    const plot = this.plots.get(sourcePanelId);
    if (!plot?.div || plot.mode !== 'timeseries' || !plot.cursors?.enabled) return;
    if (plot._cursorBoxZoomActive) {
        return;
    }
    if (!plot._relayoutLiveOnly && this._relayoutEventTouchesYAxis(eventData)) {
        return;
    }
    const update = this._xAxisUpdateFromRelayout(eventData);
    const range = Array.isArray(update?.['xaxis.range'])
        ? update['xaxis.range']
        : plot.div._fullLayout?.xaxis?.range;
    if (!Array.isArray(range) || range.length < 2) return;
    this._renderCursorOverlay(plot, { range, lightweight: true });
};

proto._relayoutEventTouchesYAxis = function(eventData) {
    if (!eventData) return false;
    return eventData['yaxis.range'] !== undefined
        || eventData['yaxis.range[0]'] !== undefined
        || eventData['yaxis.range[1]'] !== undefined
        || eventData['yaxis.autorange'] !== undefined;
};

proto._xAxisUpdateFromRelayout = function(eventData) {
    if (!eventData) return null;
    if (eventData['xaxis.autorange'] === true) return { 'xaxis.autorange': true };

    const range = eventData['xaxis.range'];
    if (Array.isArray(range) && range.length >= 2) {
        return { 'xaxis.range': [range[0], range[1]] };
    }

    const r0 = eventData['xaxis.range[0]'];
    const r1 = eventData['xaxis.range[1]'];
    if (r0 !== undefined && r1 !== undefined) {
        return { 'xaxis.range': [r0, r1] };
    }

    return null;
};

proto._refreshTimeseriesVisuals = function(panelId, plot = this.plots.get(panelId), visibleRange = null) {
    if (!plot?.div || plot.mode !== 'timeseries') return;
    const range = visibleRange
        || plot.div._fullLayout?.xaxis?.range
        || plot.div.layout?.xaxis?.range
        || null;

    // Detect whether any trace's file is DuckDB-backed (lazy mode). If so,
    // route through the async path so high-resolution viewport data is
    // fetched on demand from the underlying file rather than from the
    // in-memory overview.
    const hasLazy = plot.traces.some(t => this.files.get(t.fileId)?.data?._duckdb);
    if (hasLazy && range) {
        this._refreshTimeseriesVisualsLazy(panelId, plot, range);
        return;
    }

    // Batched restyle: collect every trace's new x/y/customdata into one
    // Plotly.restyle call instead of N serial calls. With "overlay traces
    // from all loaded files" the same panel can easily host 20–30 traces,
    // and per-trace restyles each run their own Plotly update cycle —
    // measurably slow at that count.
    const xs = [];
    const ys = [];
    const cds = [];
    const indices = [];
    let anyCustomdata = false;
    plot.traces.forEach((t, idx) => {
        const built = this._buildTimeTrace(t, range);
        if (!built) return;
        xs.push(built.x);
        ys.push(built.y);
        cds.push(built.customdata ?? null);
        if (built.customdata) anyCustomdata = true;
        indices.push(idx);
    });
    if (indices.length) {
        const update = { x: xs, y: ys };
        if (anyCustomdata) update.customdata = cds;
        Plotly.restyle(plot.div, update, indices);
    }
    this._refreshElapsedDateTimeAxisTicks(plot, range);
};

proto._refreshTimeseriesVisualsLazy = function(panelId, plot, range) {
    if (!this._zoomTokens) this._zoomTokens = new Map();
    const token = (this._zoomTokens.get(panelId) || 0) + 1;
    this._zoomTokens.set(panelId, token);
    this._cancelPendingLazyDetail(panelId);
    this._cancelActiveLazySources(panelId);

    const targetInfo = this._lazyTimeseriesTarget();
    const target = targetInfo.limit;
    const [t0, t1] = range.map(v => this._coerceAxisValue(v));
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return Promise.resolve();
    const perf = this._beginLazyPerf(panelId, plot, {
        token,
        range: [t0, t1],
        target,
        capped: !!targetInfo.capped,
    });

    let lazyQueryCount = 0;
    const previewResults = [];
    const immediateResults = [];
    const queryGroups = new Map();
    plot.traces.forEach((t, idx) => {
        const fileEntry = this.files.get(t.fileId);
        const data = fileEntry?.data;
        const lazyMeta = data?._duckdb;
        if (!lazyMeta) {
            // Mixed lazy/eager: fall back to the sync path for this trace.
            const built = this._buildTimeTrace(t, range);
            if (built) immediateResults.push({ idx, x: built.x, y: built.y, customdata: built.customdata, prepared: true });
            if (perf) perf.eagerTraces++;
            return;
        }
        if (perf) perf.lazyTraces++;
        const timeVar = this._getTimeVar(t.fileId);
        const sourceViewportRange = this._sourceRangeForDisplayRange(t.fileId, [t0, t1], timeVar);
        if (!sourceViewportRange || !sourceViewportRange.every(Number.isFinite)) {
            const built = this._buildTimeTrace(t, range);
            if (built) immediateResults.push({ idx, x: built.x, y: built.y, customdata: built.customdata, prepared: true });
            if (perf) perf.overviewTraces++;
            return;
        }
        const [sourceT0, sourceT1] = sourceViewportRange;

        // Density heuristic: if the in-memory overview already has enough
        // resolution in the visible range, skip the DuckDB round-trip. The
        // overview holds `overviewPoints` samples spread uniformly across
        // [timeStart, timeEnd]; for a viewport covering `coverage` of that
        // span, it carries ~ overviewPoints*coverage samples — already
        // greater than the target visual budget when zoomed out far.
        const tStart = Number(data?.metadata?.timeStart);
        const tEnd = Number(data?.metadata?.timeEnd);
        if (Number.isFinite(tStart) && Number.isFinite(tEnd) && tEnd > tStart) {
            const minSource = Math.min(sourceT0, sourceT1);
            const maxSource = Math.max(sourceT0, sourceT1);
            const overlap = Math.max(0, Math.min(maxSource, tEnd) - Math.max(minSource, tStart));
            const coverage = overlap / (tEnd - tStart);
            const overviewPts = Number(data?.variables?.[data?.metadata?.timeName]?.data?.length)
                || lazyMeta.overviewPoints
                || 10000;
            const overviewPtsInView = overviewPts * coverage;
            if (overviewPtsInView >= target * 1.25) {
                // Overview is enough — use the sync path (slice + downsample in JS).
                const built = this._buildTimeTrace(t, range);
                if (built) immediateResults.push({ idx, x: built.x, y: built.y, customdata: built.customdata, prepared: true });
                if (perf) perf.overviewTraces++;
                return;
            }
        }

        const cached = this._lazyCacheResult(t, idx, sourceT0, sourceT1, target);
        if (cached) {
            immediateResults.push(cached);
            if (perf) perf.traceCacheHits++;
            return;
        }

        const source = lazyMeta.source;
        if (!source?.getColumnRange) {
            return;
        }
        lazyQueryCount++;
        const queryRange = this._lazyExpandedRange(data, sourceT0, sourceT1);
        const queryTarget = this._lazyExpandedTarget(target, queryRange, sourceT0, sourceT1);
        const preview = this._renderedTracePreview(plot, idx, t0, t1, target);
        if (preview) previewResults.push({ idx, x: preview.x, y: preview.y, prepared: true });
        if (perf && preview) perf.previewTraces++;

        const groupKey = [
            t.fileId,
            queryRange[0],
            queryRange[1],
            queryTarget,
        ].join('\u0001');
        let group = queryGroups.get(groupKey);
        if (!group) {
            group = { source, data, queryRange, queryTarget, sourceViewportRange, displayViewportRange: [t0, t1], items: [] };
            queryGroups.set(groupKey, group);
        }
        group.items.push({ trace: t, idx });
    });

    if (previewResults.length && this._zoomTokens.get(panelId) === token) {
        this._applyBatchedTimeseriesRestyle(plot, previewResults);
    }
    if (immediateResults.length && this._zoomTokens.get(panelId) === token) {
        this._applyBatchedTimeseriesRestyle(plot, immediateResults);
    }
    if (lazyQueryCount > 0) this._setLazyDetailLoading(plot, true, targetInfo);
    else this._setLazyDetailLoading(plot, false);
    this._refreshElapsedDateTimeAxisTicks(plot, range);
    if (lazyQueryCount === 0) {
        const settledNoQuery = Promise.resolve(immediateResults);
        this._lastLazyRefresh = settledNoQuery;
        this._finishLazyPerf(perf, { status: 'cache-or-overview', results: immediateResults });
        return settledNoQuery;
    }

    const queryGroupsList = [...queryGroups.values()];
    if (perf) {
        perf.queryGroups = queryGroupsList.length;
        perf.queries = lazyQueryCount;
        perf.setupMs = this._roundPerfMs(this._perfNow() - perf.startedAt);
    }
    this._rememberActiveLazySources(panelId, queryGroupsList.map(group => group.source));
    const settled = this._scheduleLazyDetail(panelId, async () => {
        if (perf) perf.debounceMs = this._roundPerfMs(this._perfNow() - perf.startedAt - (perf.setupMs || 0));
        const results = [];
        for (const group of queryGroupsList) {
            if (this._zoomTokens.get(panelId) !== token) break;
            results.push(await this._runLazyDetailGroup(panelId, token, plot, group, target));
        }
        return results;
    }).then(async results => {
        if (this._zoomTokens.get(panelId) !== token) {
            this._finishLazyPerf(perf, { status: 'stale', results: results.flat?.() || [] });
            return results;
        }
        const flat = [];
        for (const result of results) {
            if (Array.isArray(result)) {
                if (perf && result._omvPerf) perf.groupPerf.push(result._omvPerf);
                flat.push(...result);
            } else if (result) {
                flat.push(result);
            }
        }
        const restyleStartedAt = this._perfNow();
        await this._applyBatchedTimeseriesRestyle(plot, flat);
        if (perf) {
            perf.restyleMs = this._roundPerfMs(this._perfNow() - restyleStartedAt);
            this._finishLazyPerf(perf, { status: 'loaded', results: flat });
        }
        return flat;
    }).catch(err => {
        this._finishLazyPerf(perf, { status: err?.name === 'AbortError' ? 'cancelled' : 'error', error: err });
        throw err;
    });
    // Expose the in-flight promise so benchmarks (or tests) can await it.
    this._lastLazyRefresh = settled;
    // Re-render the measurement cursor (A|B) overlay + info box once the
    // lazy queries have actually replaced the trace data. _onRelayout drew
    // the cursor synchronously above with stale rendered points, so without
    // this re-draw the round dot ends up floating off the curve at deep
    // zoom — the data under it changed while the cursor was already painted.
    settled.then(() => {
        if (this._zoomTokens.get(panelId) !== token) return;
        if (!plot?.div) return;
        if (plot?.cursors?.enabled) {
            try { this._syncCursorDisplay(panelId, plot); } catch (_) { /* ignore */ }
        }
        this._setLazyDetailLoading(plot, false);
    }).catch(() => { /* per-trace errors already handled */ });
    settled.finally(() => {
        if (this._zoomTokens.get(panelId) === token) {
            this._clearActiveLazySources(panelId);
        }
    });
    return settled;
};

proto._refreshPhaseVisualsLazy = function(panelId, plot = this.plots.get(panelId)) {
    if (!plot?.div || !['phase2d', 'phase2dt', 'phase3d'].includes(plot.mode)) return Promise.resolve([]);
    const lazyItems = [];
    const targetInfo = this._phaseTargetInfo();
    plot.phaseTraces.forEach((pt, idx) => {
        const data = this.files.get(pt.fileId)?.data;
        const source = data?._duckdb?.source;
        if (!source?.getPhaseTrajectory) return;
        if (this._phaseCachedTrajectory(plot, pt, targetInfo)) return;
        lazyItems.push({ pt, idx, data, source });
    });
    if (!lazyItems.length) {
        this._setLazyDetailLoading(plot, false);
        return Promise.resolve([]);
    }

    if (!this._phaseLazyTokens) this._phaseLazyTokens = new Map();
    const token = (this._phaseLazyTokens.get(panelId) || 0) + 1;
    this._phaseLazyTokens.set(panelId, token);
    this._cancelPendingLazyDetail(panelId);
    this._cancelActiveLazySources(panelId);
    this._setLazyDetailLoading(plot, true, targetInfo, 'phase');
    this._rememberActiveLazySources(panelId, lazyItems.map(item => item.source));

    const settled = this._scheduleLazyDetail(panelId, async () => {
        const results = [];
        for (const item of lazyItems) {
            if (this._phaseLazyTokens.get(panelId) !== token) break;
            results.push(await this._runLazyPhaseItem(panelId, token, plot, item, targetInfo));
        }
        return results.filter(Boolean);
    }).then(async results => {
        if (this._phaseLazyTokens.get(panelId) !== token) return results;
        await this._applyBatchedPhaseRestyle(plot, results);
        await this._relayoutPhaseLazyExtents(plot);
        this._setLazyDetailLoading(plot, false);
        return results;
    }).catch(err => {
        if (this._phaseLazyTokens.get(panelId) === token) {
            console.warn('[duckdb] lazy phase query failed; keeping current phase view:', err?.message || err);
            this._setLazyDetailLoading(plot, false);
        }
        return [];
    }).finally(() => {
        if (this._phaseLazyTokens.get(panelId) === token) {
            this._clearActiveLazySources(panelId);
        }
    });
    this._lastLazyPhaseRefresh = settled;
    return settled;
};

proto._runLazyPhaseItem = async function(panelId, token, plot, item, targetInfo) {
    const { pt, idx, data, source } = item;
    const varNames = this._phaseTraceVariables(plot, pt);
    const key = this._phaseTraceCacheKey(plot, pt, targetInfo);
    const result = await source.getPhaseTrajectory(data, varNames, {
        maxPoints: targetInfo.limit,
        sourceTimeRange: this._phaseSourceTimeRange(pt.fileId),
    });
    if (this._phaseLazyTokens.get(panelId) !== token) return null;
    const transformed = this._transformFetchedPhaseTrajectory(
        pt.fileId,
        result.time,
        result.rowIndex,
        result.yByVar,
        varNames
    );
    const visual = {
        time: transformed.time,
        x: transformed.valuesByVar.get(pt.x) || new Float64Array(0),
        y: transformed.valuesByVar.get(pt.y) || new Float64Array(0),
        z: plot.mode === 'phase3d' ? (transformed.valuesByVar.get(pt.z) || new Float64Array(0)) : undefined,
        _perf: result._perf || null,
    };
    pt._lazyPhaseCache = { key, visual };
    return { idx, pt, visual };
};

proto._applyBatchedPhaseRestyle = function(plot, results = []) {
    if (!plot?.div) return Promise.resolve();
    const valid = results
        .filter(result => result && Number.isInteger(result.idx) && plot.phaseTraces[result.idx])
        .sort((a, b) => a.idx - b.idx);
    if (!valid.length) return Promise.resolve();

    const xs = [];
    const ys = [];
    const zs = [];
    const indices = [];
    for (const result of valid) {
        const { pt, visual } = result;
        if (plot.mode === 'phase2dt') {
            const timeVar = this._getTimeVar(pt.fileId);
            xs.push(this._plotlyTimeArray(pt.fileId, visual.time, timeVar));
            ys.push(visual.x);
            zs.push(visual.y);
        } else if (plot.mode === 'phase3d') {
            xs.push(visual.x);
            ys.push(visual.y);
            zs.push(visual.z);
        } else {
            xs.push(visual.x);
            ys.push(visual.y);
        }
        indices.push(result.idx);
    }
    const update = { x: xs, y: ys };
    if (plot.mode === 'phase2dt' || plot.mode === 'phase3d') update.z = zs;
    return Plotly.restyle(plot.div, update, indices);
};

proto._relayoutPhaseLazyExtents = function(plot) {
    if (!plot?.div || !['phase2d', 'phase2dt', 'phase3d'].includes(plot.mode)) return Promise.resolve();
    const update = {};
    if (plot.mode === 'phase2d') {
        const layout = this._buildPhase2DLayout(plot);
        if (layout.xaxis?.range) update['xaxis.range'] = layout.xaxis.range;
        if (layout.yaxis?.range) update['yaxis.range'] = layout.yaxis.range;
    } else {
        const layout = this._buildPhase3DLayout(plot, plot.mode === 'phase2dt');
        update['scene.xaxis.range'] = layout.scene.xaxis.range;
        update['scene.yaxis.range'] = layout.scene.yaxis.range;
        update['scene.zaxis.range'] = layout.scene.zaxis.range;
        const cam = plot.div._fullLayout?.scene?.camera;
        if (cam) update['scene.camera'] = cam;
    }
    return Object.keys(update).length ? Plotly.relayout(plot.div, update) : Promise.resolve();
};

proto._scheduleLazyDetail = function(panelId, run) {
    if (!this._lazyDetailTimers) this._lazyDetailTimers = new Map();
    const delayMs = 90;
    const scheduled = {};
    const promise = new Promise((resolve, reject) => {
        scheduled.resolve = resolve;
        scheduled.reject = reject;
        scheduled.timer = setTimeout(() => {
            this._lazyDetailTimers.delete(panelId);
            Promise.resolve()
                .then(run)
                .then(resolve, reject);
        }, delayMs);
    });
    this._lazyDetailTimers.set(panelId, scheduled);
    return promise;
};

proto._cancelPendingLazyDetail = function(panelId) {
    const scheduled = this._lazyDetailTimers?.get(panelId);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    this._lazyDetailTimers.delete(panelId);
    scheduled.resolve([]);
};

proto._rememberActiveLazySources = function(panelId, sources = []) {
    if (!this._lazyActiveSources) this._lazyActiveSources = new Map();
    const active = new Set(sources.filter(Boolean));
    if (active.size) this._lazyActiveSources.set(panelId, active);
};

proto._clearActiveLazySources = function(panelId) {
    this._lazyActiveSources?.delete(panelId);
};

proto._cancelActiveLazySources = function(panelId) {
    const active = this._lazyActiveSources?.get(panelId);
    if (!active?.size) return;
    this._lazyActiveSources.delete(panelId);
    for (const source of active) {
        if (typeof source?.cancelActiveQuery === 'function') {
            Promise.resolve(source.cancelActiveQuery()).catch(() => null);
        }
    }
};

proto._cleanupLazyDetailForPanel = function(panelId, plot = this.plots?.get(panelId)) {
    this._cancelPendingLazyDetail(panelId);
    this._cancelActiveLazySources(panelId);
    if (this._zoomTokens) {
        this._zoomTokens.set(panelId, (this._zoomTokens.get(panelId) || 0) + 1);
    }
    if (this._phaseLazyTokens) {
        this._phaseLazyTokens.set(panelId, (this._phaseLazyTokens.get(panelId) || 0) + 1);
    }
    if (plot) this._setLazyDetailLoading(plot, false);
    const panelEl = plot?.div?.closest?.('.layout-panel')
        || (typeof document !== 'undefined' ? document.querySelector(`.layout-panel[data-id="${panelId}"]`) : null);
    panelEl?.querySelectorAll('.lazy-detail-indicator').forEach(indicator => indicator.remove());
};

proto._runLazyDetailGroup = function(panelId, token, plot, group, target) {
    const varNames = group.items.map(item => item.trace.varName);
    const startedAt = this._perfNow();
    const fetch = group.source?.getColumnsRange
        ? group.source.getColumnsRange(group.data, varNames, group.queryRange[0], group.queryRange[1], group.queryTarget)
        : Promise.all(varNames.map(varName =>
            group.source.getColumnRange(group.data, varName, group.queryRange[0], group.queryRange[1], group.queryTarget)
        )).then(series => ({
            x: series[0]?.x || new Float64Array(0),
            yByVar: new Map(series.map((entry, index) => [varNames[index], entry?.y || new Float64Array(0)])),
        }));

    return fetch.then(({ x, yByVar, _perf }) => {
        if (this._zoomTokens.get(panelId) !== token) return [];
        if (!plot?.div) return [];
        const mapped = group.items.map(({ trace, idx }) => {
            if (!plot.traces[idx]) return null;
            const y = yByVar?.get(trace.varName);
            if (!y) return null;
            trace._lazyDetailCache = {
                fileId: trace.fileId,
                varName: trace.varName,
                start: group.queryRange[0],
                end: group.queryRange[1],
                target: group.queryTarget,
                x,
                y,
            };
            const [sourceT0, sourceT1] = group.sourceViewportRange || group.queryRange;
            return this._lazyCacheResult(trace, idx, sourceT0, sourceT1, target) || { idx, trace, x, y };
        });
        mapped._omvPerf = {
            ...(_perf || {}),
            elapsedMs: this._roundPerfMs(this._perfNow() - startedAt),
            traces: group.items.length,
            outputRows: x?.length || 0,
            queryTarget: group.queryTarget,
        };
        return mapped;
    }).catch(err => {
        if (this._zoomTokens.get(panelId) !== token) return [];
        console.warn('[duckdb] grouped viewport query failed; keeping current lazy view:', err?.message || err);
        const [displayT0, displayT1] = group.displayViewportRange || group.sourceViewportRange || group.queryRange;
        return group.items.map(({ idx }) => {
            const preview = this._renderedTracePreview(plot, idx, displayT0, displayT1, target);
            return preview ? { ...preview, idx, prepared: true } : null;
        });
    });
};

proto._renderedTracePreview = function(plot, idx, t0, t1, target) {
    const rendered = plot?.div?.data?.[idx];
    const xValues = rendered?.x;
    const yValues = rendered?.y;
    const n = Math.min(xValues?.length || 0, yValues?.length || 0);
    if (n <= 1) return null;
    const minX = Math.min(t0, t1);
    const maxX = Math.max(t0, t1);
    const xs = [];
    const ys = [];
    for (let i = 0; i < n; i++) {
        const x = this._coerceAxisValue(xValues[i]);
        if (!Number.isFinite(x)) continue;
        if (x < minX || x > maxX) continue;
        xs.push(xValues[i]);
        ys.push(yValues[i]);
    }
    if (xs.length < 2) return null;
    if (!Number.isFinite(target) || target <= 0 || xs.length <= target) {
        return { x: xs, y: ys };
    }
    return this._downsampleTimeseries(xs, ys, target);
};

proto._lazyCacheResult = function(trace, idx, t0, t1, target) {
    const cache = trace?._lazyDetailCache;
    if (!cache || cache.fileId !== trace.fileId || cache.varName !== trace.varName) return null;
    if (!cache.x?.length || !cache.y?.length) return null;
    if (Number.isFinite(cache.target) && cache.target < target) return null;
    const minX = Math.min(t0, t1);
    const maxX = Math.max(t0, t1);
    if (minX < cache.start || maxX > cache.end) return null;
    if (!this._lazyCacheHasViewportDetail(cache, minX, maxX, target)) return null;
    const visual = this._visualFromSeriesRange(cache.x, cache.y, minX, maxX, target);
    return visual ? { idx, trace, x: visual.x, y: visual.y } : null;
};

proto._lazyCacheHasViewportDetail = function(cache, minX, maxX, target) {
    const n = Math.min(cache.x?.length || 0, cache.y?.length || 0);
    if (n <= 0) return false;
    const start = this._lowerBound(cache.x, minX);
    const end = this._upperBound(cache.x, maxX);
    const pointsInView = Math.max(0, end - start);
    const finiteTarget = Number.isFinite(target) && target > 0 ? target : 4000;
    const required = Math.max(32, Math.min(finiteTarget * 0.6, 1200));
    if (pointsInView >= required) return true;

    // If the cache is already roughly the same width as the viewport, another
    // query cannot materially increase horizontal resolution without changing
    // the configured point budget. Reuse it to avoid query loops on sparse data.
    const cacheSpan = cache.end - cache.start;
    const viewSpan = maxX - minX;
    return Number.isFinite(cacheSpan)
        && Number.isFinite(viewSpan)
        && viewSpan > 0
        && cacheSpan <= viewSpan * 1.25;
};

proto._visualFromSeriesRange = function(xValues, yValues, minX, maxX, target) {
    const n = Math.min(xValues?.length || 0, yValues?.length || 0);
    if (n <= 0) return null;
    let start = this._lowerBound(xValues, minX);
    let end = this._upperBound(xValues, maxX);
    start = Math.max(0, start - 1);
    end = Math.min(n, end + 1);
    if (end - start <= 0) return { x: new Float64Array(0), y: new Float64Array(0) };
    const sliceX = xValues.slice(start, end);
    const sliceY = yValues.slice(start, end);
    if (!Number.isFinite(target) || target <= 0 || sliceX.length <= target) {
        return { x: sliceX, y: sliceY };
    }
    return this._downsampleTimeseries(sliceX, sliceY, target);
};

proto._lazyExpandedRange = function(data, t0, t1) {
    const minX = Math.min(t0, t1);
    const maxX = Math.max(t0, t1);
    const span = maxX - minX;
    if (!Number.isFinite(span) || span <= 0) return [minX, maxX];
    const tileWidth = span;
    let start = minX - span;
    let end = maxX + span;
    if (Number.isFinite(tileWidth) && tileWidth > 0) {
        const startTile = Math.floor(minX / tileWidth) - 1;
        const endTile = Math.ceil(maxX / tileWidth) + 1;
        const tiledStart = startTile * tileWidth;
        const tiledEnd = endTile * tileWidth;
        if (Number.isFinite(tiledStart) && Number.isFinite(tiledEnd) && tiledStart < tiledEnd) {
            start = tiledStart;
            end = tiledEnd;
        }
    }
    const dataStart = Number(data?.metadata?.timeStart);
    const dataEnd = Number(data?.metadata?.timeEnd);
    if (Number.isFinite(dataStart)) start = Math.max(start, dataStart);
    if (Number.isFinite(dataEnd)) end = Math.min(end, dataEnd);
    return start < end ? [start, end] : [minX, maxX];
};

proto._lazyExpandedTarget = function(target, queryRange, t0, t1) {
    const viewportSpan = Math.abs(t1 - t0);
    const querySpan = Math.abs((queryRange?.[1] ?? t1) - (queryRange?.[0] ?? t0));
    const factor = viewportSpan > 0 && Number.isFinite(querySpan)
        ? Math.max(1, Math.min(4, querySpan / viewportSpan))
        : 1;
    const expanded = Math.max(target, Math.ceil(target * factor));
    const cap = Math.max(6000, target * 4);
    return Math.min(cap, expanded);
};

proto._applyBatchedTimeseriesRestyle = function(plot, results = []) {
    if (!plot?.div) return Promise.resolve();
    const valid = results
        .filter(result => result && Number.isInteger(result.idx) && plot.traces[result.idx])
        .sort((a, b) => a.idx - b.idx);
    if (!valid.length) return Promise.resolve();
    const xs = [];
    const ys = [];
    const cds = [];
    let anyCustomdata = false;
    for (const result of valid) {
        const trace = result.trace || plot.traces[result.idx];
        const prepared = result.prepared
            ? { x: result.x, y: result.y, customdata: result.customdata }
            : this._prepareLazyTimeseriesRestyle(trace, result.x, result.y);
        xs.push(prepared.x);
        ys.push(prepared.y);
        cds.push(prepared.customdata ?? null);
        if (prepared.customdata) anyCustomdata = true;
    }
    const update = { x: xs, y: ys };
    if (anyCustomdata) update.customdata = cds;
    return Plotly.restyle(plot.div, update, valid.map(result => result.idx));
};

proto._prepareLazyTimeseriesRestyle = function(trace, x, y) {
    const fileId = trace?.fileId;
    const timeVar = this._getTimeVar(fileId);
    const visualX = Array.from(x || [], (value, index) =>
        this._displayTimeForFetchedSourceTime(fileId, value, index, timeVar)
    );
    const plotX = this._plotlyTimeArray(fileId, visualX, timeVar);
    const generatedCalendarAxis = this._isGeneratedCalendarTime(fileId, timeVar);
    const durationAxis = this._timeDisplayModeForVar(fileId, timeVar) === 'elapsedDateTime'
        || (this._isGeneratedDurationTime(fileId, timeVar) && !generatedCalendarAxis);
    return {
        x: plotX,
        y,
        customdata: generatedCalendarAxis
            ? visualX.map(value => this._formatGeneratedCalendarDateTime(fileId, value, timeVar))
            : durationAxis
            ? visualX.map(value => this._formatElapsedDateTime(value, this._durationFractionDigits(fileId)))
            : undefined,
    };
};

proto._beginLazyPerf = function(panelId, plot, base = {}) {
    if (!this._lazyPerfEnabled()) return null;
    return {
        ...base,
        panelId,
        traces: plot?.traces?.length || 0,
        lazyTraces: 0,
        eagerTraces: 0,
        overviewTraces: 0,
        traceCacheHits: 0,
        previewTraces: 0,
        queryGroups: 0,
        queries: 0,
        groupPerf: [],
        startedAt: this._perfNow(),
    };
};

proto._finishLazyPerf = function(perf, { status, results = [], error = null } = {}) {
    if (!perf) return;
    if (perf.finished) return;
    perf.finished = true;
    const finished = {
        ...perf,
        status,
        resultTraces: results.filter(Boolean).length,
        outputPoints: results.reduce((sum, result) => sum + (result?.x?.length || 0), 0),
        totalMs: this._roundPerfMs(this._perfNow() - perf.startedAt),
    };
    if (error) finished.error = error?.message || String(error);
    delete finished.startedAt;
    this._lastLazyPerf = finished;
    if (perf.panelId && this.plots?.has(perf.panelId)) {
        this.plots.get(perf.panelId)._lastLazyPerf = finished;
    }
    console.debug('[omv-perf] lazy detail', finished);
    if (finished.groupPerf?.length && console.table) {
        console.table(finished.groupPerf);
    }
};

proto._lazyPerfEnabled = function() {
    try {
        return globalThis.localStorage?.getItem('omv_perf_debug') === '1';
    } catch (_) {
        return false;
    }
};

proto._perfNow = function() {
    return globalThis.performance?.now?.() ?? Date.now();
};

proto._roundPerfMs = function(value) {
    return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
};

proto._maxTimeseriesDownsamplingMenuLimit = function() {
    const select = typeof document !== 'undefined'
        ? document.getElementById('timeseries-downsampling')
        : null;
    const values = select
        ? [...select.options].map(option => Number(option.value)).filter(value => Number.isFinite(value) && value > 0)
        : [];
    const max = values.length ? Math.max(...values) : NaN;
    return Number.isFinite(max) ? Math.round(max) : PlotManager.MAX_MENU_VISUAL_POINTS;
};

proto._maxPhaseDownsamplingMenuLimit = function() {
    const select = typeof document !== 'undefined'
        ? document.getElementById('phase-downsampling')
        : null;
    const values = select
        ? [...select.options].map(option => Number(option.value)).filter(value => Number.isFinite(value) && value > 0)
        : [];
    const max = values.length ? Math.max(...values) : NaN;
    return Number.isFinite(max) ? Math.round(max) : PlotManager.MAX_MENU_VISUAL_POINTS;
};

proto._lazyTimeseriesTarget = function() {
    const configured = this.timeseriesVisualMaxPoints;
    if (Number.isFinite(configured) && configured > 0) {
        return { limit: Math.round(configured), capped: false };
    }
    // "No downsampling" is unsafe for lazy files: it could request millions
    // of points from DuckDB and hand them to Plotly. Use the highest numeric
    // menu budget so "none" remains monotonic with explicit options.
    return { limit: this._maxTimeseriesDownsamplingMenuLimit(), capped: true };
};

proto._setLazyDetailLoading = function(plot, loading, targetInfo = null, kind = 'timeseries') {
    const panelEl = plot?.div?.closest('.layout-panel');
    if (!panelEl) return;
    let indicator = panelEl.querySelector('.lazy-detail-indicator');
    if (loading && !indicator) {
        indicator = document.createElement('div');
        indicator.className = 'lazy-detail-indicator';
        indicator.setAttribute('aria-live', 'polite');
        indicator.innerHTML = '<span class="lazy-detail-spinner" aria-hidden="true"></span><span class="lazy-detail-text">Loading detail</span>';
        panelEl.appendChild(indicator);
    }
    if (!indicator) return;
    if (loading) {
        const capped = targetInfo?.capped;
        const limit = targetInfo?.limit || 2000;
        const key = kind === 'phase'
            ? (capped ? 'lazyPhaseLoadingCapped' : 'lazyPhaseLoading')
            : (capped ? 'lazyDetailLoadingCapped' : 'lazyDetailLoading');
        indicator.title = i18n.t(key).replace('{limit}', String(limit));
        indicator.setAttribute('aria-label', indicator.title);
        const text = indicator.querySelector('.lazy-detail-text');
        if (text) text.textContent = kind === 'phase' ? 'Loading phase' : 'Loading detail';
        indicator.classList.add('active');
    } else {
        indicator.classList.remove('active');
        indicator.remove();
    }
};

proto._refreshElapsedDateTimeAxisTicks = function(plot, range = null) {
    if (!plot?.div || plot.mode !== 'timeseries') return;
    const fid = this._primaryTimeFileId(plot);
    const timeVar = this._getTimeVar(fid);
    const generatedCalendarAxis = this._isGeneratedCalendarTime(fid, timeVar);
    if (generatedCalendarAxis) {
        const values = Array.isArray(range) && range.length >= 2
            ? range.map(value => {
                const numeric = Number(value);
                return Number.isFinite(numeric) ? numeric : NaN;
            })
            : plot.traces.map(t => this._getTransformedTimeData(t.fileId));
        const config = this._calendarAxisConfig(fid, timeVar, values);
        if (!config.tickvals || !config.ticktext) return;
        Plotly.relayout(plot.div, {
            'xaxis.tickmode': config.tickmode,
            'xaxis.tickvals': config.tickvals,
            'xaxis.ticktext': config.ticktext,
        });
        return;
    }
    if (this._timeDisplayModeForVar(fid, timeVar) !== 'elapsedDateTime' && !this._isGeneratedDurationTime(fid, timeVar)) return;
    const values = Array.isArray(range) && range.length >= 2
        ? range.map(value => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : NaN;
        })
        : plot.traces.map(t => this._getTransformedTimeData(t.fileId));
    const config = this._elapsedDateTimeAxisConfig(values, fid);
    if (!config.tickvals || !config.ticktext) return;
    Plotly.relayout(plot.div, {
        'xaxis.tickmode': config.tickmode,
        'xaxis.tickvals': config.tickvals,
        'xaxis.ticktext': config.ticktext,
    });
};

proto._refreshAllTimeseriesVisuals = function() {
    for (const [panelId, plot] of this.plots) {
        if (plot?.div && plot.mode === 'timeseries') {
            this._refreshTimeseriesVisuals(panelId, plot);
        }
    }
};

proto._refreshAllPhaseVisuals = function() {
    for (const [panelId, plot] of this.plots) {
        if (plot?.div && (plot.mode === 'phase2d' || plot.mode === 'phase2dt' || plot.mode === 'phase3d')) {
            this._rebuildPanel(panelId, { preserveView: true });
        }
    }
};

proto._syncXAxisUpdate = function(sourcePanelId, update) {
    const targets = [];
    const sourcePlot = this.plots.get(sourcePanelId);
    const sourceFid = this._primaryTimeFileId(sourcePlot);
    for (const [id, plot] of this.plots) {
        if (id === sourcePanelId || !plot.div || plot.mode !== 'timeseries') continue;
        const targetFid = this._primaryTimeFileId(plot);
        if (this._timeDisplayMode(sourceFid) !== this._timeDisplayMode(targetFid)) continue;
        targets.push({ id, plot, div: plot.div });
    }
    if (targets.length === 0) return;

    this._syncing = true;
    this._syncSourcePanelId = sourcePanelId;
    Promise.all(targets.map(({ id, plot, div }) => Plotly.relayout(div, update).then(() => {
        const visibleRange = Array.isArray(update['xaxis.range']) ? update['xaxis.range'] : null;
        this._refreshTimeseriesVisuals(id, plot, visibleRange);
    })))
        .finally(() => {
            this._syncing = false;
            this._syncSourcePanelId = null;

            const pending = this._pendingAxisSync;
            this._pendingAxisSync = null;
            if (pending) this._syncXAxisUpdate(pending.sourcePanelId, pending.update);
        });
};

// ─── Synchronized hover ────────────────────────────────────────

proto._onHover = function(sourcePanelId, eventData) {
    if (!this.syncHover || this._hovering) return;
    const pt = eventData.points?.[0];
    if (pt == null) return;
    const traceName = pt.data?.name || pt.fullData?.name;
    if (traceName === '__hover__' || traceName === '__origin__') return;
    if (this._hoverClearTimer) {
        clearTimeout(this._hoverClearTimer);
        this._hoverClearTimer = null;
    }
    const sourceXVal = this._coerceAxisValue(pt.x);   // hovered time value
    if (!Number.isFinite(sourceXVal)) return;

    this._hovering = true;
    try {
        const srcPlot    = this.plots.get(sourcePanelId);
        const srcFid     = srcPlot?.traces?.[0]?.fileId ?? this.activeFileId;
        const formatHoverTime = (fileId, x) => this._formatTimeValue(fileId || srcFid, x);

        for (const [, plot] of this.plots) {
            if (!plot.div || !plot.div.isConnected) continue;
            const panelEl = plot.div.closest('.layout-panel');
            const targetFid = this._primaryTimeFileId(plot);
            const xVal = this._mapTimeValueBetweenFiles(srcFid, targetFid, sourceXVal);
            if (!Number.isFinite(xVal)) continue;
            const plotXVal = this._plotlyTimeValue(targetFid, xVal, this._getTimeVar(targetFid));
            const targetTimeUnit = this._timeUnitLabel(targetFid);
            const targetTimeSuffix = (targetTimeUnit === 'datetime' || targetTimeUnit === 'duration') ? '' : ' ' + this._escapeHTML(targetTimeUnit);

            if (plot.mode === 'timeseries') {
                const lines = [`<b>t = ${this._escapeHTML(formatHoverTime(targetFid, xVal))}${targetTimeSuffix}</b>`];
                const markers = [];
                plot.traces.forEach(t => {
                    if (t.visible === 'legendonly' || t.visible === false) return;
                    const d    = this.files.get(t.fileId)?.data;
                    const v    = d?.variables[t.varName];
                    const tdata = this._getTransformedTimeData(t.fileId);
                    const traceXVal = this._mapTimeValueBetweenFiles(srcFid, t.fileId, sourceXVal);
                    const tidx = this._findTimeIdx(tdata, traceXVal);
                    const ydata = v ? this._getTransformedVariableData(t.fileId, t.varName) : [];
                    if (v && v.kind !== 'parameter' && ydata.length) {
                        const unit  = this._extractUnit(v.description);
                        const label = this._traceName(t.varName, t.fileId);
                        const matchedX = tdata[tidx];
                        if (Number.isFinite(matchedX) && Number.isFinite(ydata[tidx])) {
                            markers.push({
                                x: this._plotlyTimeValue(t.fileId, matchedX, this._getTimeVar(t.fileId)),
                                y: ydata[tidx],
                                color: t.color,
                            });
                        }
                        lines.push(`<span style="color:${t.color}">●</span> ${this._escapeHTML(label)} = ${this._formatHTMLNumber(ydata[tidx])}${unit ? ' ' + this._escapeHTML(unit) : ''}`);
                    }
                });
                this._renderHoverOverlay(plot, plotXVal, markers);
                this._showInfoBox(panelEl, lines.join('<br>'));

            } else if (plot.mode === 'phase2d') {
                if (plot.markerTraceIdx != null) {
                    plot.phaseTraces.forEach((pt2, i) => {
                        const hidden = pt2.visible === 'legendonly' || pt2.visible === false;
                        const d = this.files.get(pt2.fileId)?.data;
                        if (!d) return;
                        const xv = d.variables[pt2.x], yv = d.variables[pt2.y];
                        if (!xv || !yv) return;
                        const tdata = this._getTransformedTimeData(pt2.fileId);
                        const midx = Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx[i] : plot.markerTraceIdx;
                        if (hidden) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
                        const traceXVal = this._mapTimeValueBetweenFiles(srcFid, pt2.fileId, sourceXVal);
                        if (!Number.isFinite(traceXVal)) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
                        const tidx = this._findTimeIdx(tdata, traceXVal);
                        const xdata = this._getTransformedVariableData(pt2.fileId, pt2.x);
                        const ydata = this._getTransformedVariableData(pt2.fileId, pt2.y);
                        Plotly.restyle(plot.div, { x: [[xdata[tidx]]], y: [[ydata[tidx]]], visible: true }, [midx]);
                    });
                }
                const lines = [`<b>t = ${this._escapeHTML(formatHoverTime(targetFid, xVal))}${targetTimeSuffix}</b>`];
                plot.phaseTraces.forEach(pt2 => {
                    if (pt2.visible === 'legendonly' || pt2.visible === false) return;
                    const d = this.files.get(pt2.fileId)?.data;
                    if (!d) return;
                    const xv = d.variables[pt2.x], yv = d.variables[pt2.y];
                    if (xv && yv) {
                        const tdata = this._getTransformedTimeData(pt2.fileId);
                        const traceXVal = this._mapTimeValueBetweenFiles(srcFid, pt2.fileId, sourceXVal);
                        if (!Number.isFinite(traceXVal)) return;
                        const tidx = this._findTimeIdx(tdata, traceXVal);
                        const xdata = this._getTransformedVariableData(pt2.fileId, pt2.x);
                        const ydata = this._getTransformedVariableData(pt2.fileId, pt2.y);
                        const xu = this._extractUnit(xv.description), yu = this._extractUnit(yv.description);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${this._escapeHTML(pt2.x)} = ${this._formatHTMLNumber(xdata[tidx])}${xu ? ' ' + this._escapeHTML(xu) : ''}`);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${this._escapeHTML(pt2.y)} = ${this._formatHTMLNumber(ydata[tidx])}${yu ? ' ' + this._escapeHTML(yu) : ''}`);
                    }
                });
                this._showInfoBox(panelEl, lines.join('<br>'));

            } else if (plot.mode === 'phase2dt') {
                if (plot.markerTraceIdx != null) {
                    plot.phaseTraces.forEach((pt2, i) => {
                        const hidden = pt2.visible === 'legendonly' || pt2.visible === false;
                        const d = this.files.get(pt2.fileId)?.data;
                        if (!d) return;
                        const xv = d.variables[pt2.x], yv = d.variables[pt2.y];
                        if (!xv || !yv) return;
                        const tdata = this._getTransformedTimeData(pt2.fileId);
                        const midx = Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx[i] : plot.markerTraceIdx;
                        if (hidden) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
                        const traceXVal = this._mapTimeValueBetweenFiles(srcFid, pt2.fileId, sourceXVal);
                        if (!Number.isFinite(traceXVal)) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
                        const tidx = this._findTimeIdx(tdata, traceXVal);
                        const xdata = this._getTransformedVariableData(pt2.fileId, pt2.x);
                        const ydata = this._getTransformedVariableData(pt2.fileId, pt2.y);
                        Plotly.restyle(plot.div, { x: [[this._plotlyTimeValue(pt2.fileId, traceXVal, this._getTimeVar(pt2.fileId))]], y: [[xdata[tidx]]], z: [[ydata[tidx]]], visible: true }, [midx]);
                    });
                }
                const lines = [`<b>t = ${this._escapeHTML(formatHoverTime(targetFid, xVal))}${targetTimeSuffix}</b>`];
                plot.phaseTraces.forEach(pt2 => {
                    if (pt2.visible === 'legendonly' || pt2.visible === false) return;
                    const d = this.files.get(pt2.fileId)?.data;
                    if (!d) return;
                    const xv = d.variables[pt2.x], yv = d.variables[pt2.y];
                    if (xv && yv) {
                        const tdata = this._getTransformedTimeData(pt2.fileId);
                        const traceXVal = this._mapTimeValueBetweenFiles(srcFid, pt2.fileId, sourceXVal);
                        if (!Number.isFinite(traceXVal)) return;
                        const tidx = this._findTimeIdx(tdata, traceXVal);
                        const xdata = this._getTransformedVariableData(pt2.fileId, pt2.x);
                        const ydata = this._getTransformedVariableData(pt2.fileId, pt2.y);
                        const xu = this._extractUnit(xv.description), zu = this._extractUnit(yv.description);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${this._escapeHTML(pt2.x)} = ${this._formatHTMLNumber(xdata[tidx])}${xu ? ' ' + this._escapeHTML(xu) : ''}`);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${this._escapeHTML(pt2.y)} = ${this._formatHTMLNumber(ydata[tidx])}${zu ? ' ' + this._escapeHTML(zu) : ''}`);
                    }
                });
                this._showInfoBox(panelEl, lines.join('<br>'));

            } else if (plot.mode === 'phase3d') {
                if (plot.markerTraceIdx != null) {
                    plot.phaseTraces.forEach((pt2, i) => {
                        const hidden = pt2.visible === 'legendonly' || pt2.visible === false;
                        const d = this.files.get(pt2.fileId)?.data;
                        if (!d) return;
                        const xv = d.variables[pt2.x], yv = d.variables[pt2.y], zv = d.variables[pt2.z];
                        if (!xv || !yv || !zv) return;
                        const tdata = this._getTransformedTimeData(pt2.fileId);
                        const midx = Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx[i] : plot.markerTraceIdx;
                        if (hidden) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
                        const traceXVal = this._mapTimeValueBetweenFiles(srcFid, pt2.fileId, sourceXVal);
                        if (!Number.isFinite(traceXVal)) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
                        const tidx = this._findTimeIdx(tdata, traceXVal);
                        const xdata = this._getTransformedVariableData(pt2.fileId, pt2.x);
                        const ydata = this._getTransformedVariableData(pt2.fileId, pt2.y);
                        const zdata = this._getTransformedVariableData(pt2.fileId, pt2.z);
                        Plotly.restyle(plot.div, { x: [[xdata[tidx]]], y: [[ydata[tidx]]], z: [[zdata[tidx]]], visible: true }, [midx]);
                    });
                }
                const lines = [`<b>t = ${this._escapeHTML(formatHoverTime(targetFid, xVal))}${targetTimeSuffix}</b>`];
                plot.phaseTraces.forEach(pt2 => {
                    if (pt2.visible === 'legendonly' || pt2.visible === false) return;
                    const d = this.files.get(pt2.fileId)?.data;
                    if (!d) return;
                    const xv = d.variables[pt2.x], yv = d.variables[pt2.y], zv = d.variables[pt2.z];
                    if (xv && yv && zv) {
                        const tdata = this._getTransformedTimeData(pt2.fileId);
                        const traceXVal = this._mapTimeValueBetweenFiles(srcFid, pt2.fileId, sourceXVal);
                        if (!Number.isFinite(traceXVal)) return;
                        const tidx = this._findTimeIdx(tdata, traceXVal);
                        [xv, yv, zv].forEach((v, vi) => {
                            const name = [pt2.x, pt2.y, pt2.z][vi];
                            const dataName = [pt2.x, pt2.y, pt2.z][vi];
                            const values = this._getTransformedVariableData(pt2.fileId, dataName);
                            const u = this._extractUnit(v.description);
                            lines.push(`<span style="color:${pt2.color}">●</span> ${this._escapeHTML(name)} = ${this._formatHTMLNumber(values[tidx])}${u ? ' ' + this._escapeHTML(u) : ''}`);
                        });
                    }
                });
                this._showInfoBox(panelEl, lines.join('<br>'));

            } else if (plot.mode === 'state-anim') {
                const tvar = this._getTimeVar(plot.stateSlots.fileId);
                if (tvar) {
                    const tidx = this._findTimeIdx(this._getTransformedTimeData(plot.stateSlots.fileId), xVal);
                    this._stateAnimUpdateFrame(plot, tidx);
                }
            }
        }
    } catch (error) {
        console.error('Synchronized hover failed:', error);
        this._clearHoverMarkers();
    } finally {
        this._hovering = false;
    }
};

proto._onUnhover = function(sourcePanelId) {
    if (!this.syncHover) return;
    if (this._hoverClearTimer) clearTimeout(this._hoverClearTimer);
    this._hoverClearTimer = setTimeout(() => {
        this._hoverClearTimer = null;
        this._clearHoverMarkers();
    }, 80);
};

proto._hoverOverlayGeometry = function(plot, x, y = null) {
    if (!plot?.div) return null;
    const xValue = this._coerceAxisValue(x);
    if (!Number.isFinite(xValue)) return null;
    const fl = plot.div._fullLayout;
    const xa = fl?.xaxis;
    const ya = fl?.yaxis;
    if (!xa?.range || !ya?.range || !xa._length || !ya._length) return null;

    const x0 = this._coerceAxisValue(xa.range[0]);
    const x1 = this._coerceAxisValue(xa.range[1]);
    const rx = x1 - x0;
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || rx === 0) return null;

    const left = (xa._offset || 0) + ((xValue - x0) / rx) * xa._length;
    const leftAxis = xa._offset || 0;
    const rightAxis = leftAxis + xa._length;
    const topAxis = ya._offset || 0;
    const bottomAxis = topAxis + ya._length;
    const y0 = Number(ya.range[0]);
    const y1 = Number(ya.range[1]);
    const ry = y1 - y0;
    const top = Number.isFinite(y) && Number.isFinite(y0) && Number.isFinite(y1) && ry !== 0
        ? topAxis + (1 - ((y - y0) / ry)) * ya._length
        : NaN;

    return { left, leftAxis, rightAxis, top, topAxis, bottomAxis };
};

proto._renderHoverOverlay = function(plot, x, markers = []) {
    if (!plot?.div) return;
    let overlay = plot.div.querySelector('.hover-plot-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'hover-plot-overlay';
        plot.div.appendChild(overlay);
    }

    const line = this._hoverOverlayGeometry(plot, x);
    if (!line || line.left < line.leftAxis || line.left > line.rightAxis) {
        overlay.style.display = 'none';
        overlay.innerHTML = '';
        return;
    }

    const parts = [
        `<div class="hover-overlay-line" style="left:${line.left}px;top:${line.topAxis}px;height:${Math.max(0, line.bottomAxis - line.topAxis)}px"></div>`,
    ];
    for (const marker of markers) {
        const g = this._hoverOverlayGeometry(plot, marker.x, marker.y);
        if (!g || g.left < g.leftAxis || g.left > g.rightAxis || !Number.isFinite(g.top) || g.top < g.topAxis || g.top > g.bottomAxis) continue;
        const color = this._escapeHTML(marker.color || '#888888');
        parts.push(`<div class="hover-overlay-dot" style="left:${g.left}px;top:${g.top}px;background:${color}"></div>`);
    }
    overlay.innerHTML = parts.join('');
    overlay.style.display = 'block';
};

proto._hideHoverOverlay = function(plot) {
    const overlay = plot?.div?.querySelector('.hover-plot-overlay');
    if (overlay) {
        overlay.style.display = 'none';
        overlay.innerHTML = '';
    }
};

proto._clearHoverMarkers = function(options = {}) {
    const plotlyClears = [];
    for (const [, plot] of this.plots) {
        if (!plot.div) continue;
        const panelEl = plot.div.closest('.layout-panel');
        this._hideInfoBox(panelEl);
        if (plot.mode === 'timeseries') {
            this._hideHoverOverlay(plot);
        }
        if (plot.markerTraceIdx != null) {
            if (plot.mode === 'timeseries') continue;
            const idxList = Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx : [plot.markerTraceIdx];
            idxList.forEach(i => {
                const is3d = plot.mode === 'phase2dt' || plot.mode === 'phase3d';
                const upd = is3d ? { x: [[null]], y: [[null]], z: [[null]], visible: false }
                                : { x: [[null]], y: [[null]], visible: false };
                plotlyClears.push(() => Plotly.restyle(plot.div, upd, [i]));
            });
        }
    }
    const runPlotlyClears = () => plotlyClears.forEach(fn => fn());
    if (options.deferPlotly && plotlyClears.length) requestAnimationFrame(runPlotlyClears);
    else runPlotlyClears();
};

proto._showInfoBox = function(panelEl, html) {
    if (!panelEl) return;
    let box = panelEl.querySelector('.hover-info-box');
    if (!box) {
        box = document.createElement('div');
        box.className = 'hover-info-box';
        panelEl.appendChild(box);
    }
    box.innerHTML = html;
    this._applyHoverInfoBoxPosition(box);
    box.style.display = 'block';
};

proto._hideInfoBox = function(panelEl) {
    if (!panelEl) return;
    const box = panelEl.querySelector('.hover-info-box');
    if (box) box.style.display = 'none';
};

proto._applyHoverInfoBoxPosition = function(box) {
    const corner = ['tl', 'tr', 'bl', 'br'].includes(this.hoverInfoCorner) ? this.hoverInfoCorner : 'bl';
    box.classList.remove('hover-corner-tl', 'hover-corner-tr', 'hover-corner-bl', 'hover-corner-br');
    box.classList.add(`hover-corner-${corner}`);
};

// ─── Measurement cursors (time-series panels) ─────────────────

proto._defaultCursors = function() {
    return { enabled: false, a: null, b: null, traceA: null, traceB: null, showSecant: false };
};

proto._toggleCursors = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot || plot.mode !== 'timeseries' || !plot.div) return;
    plot.cursors = { ...this._defaultCursors(), ...(plot.cursors || {}) };
    plot.cursors.enabled = !plot.cursors.enabled;
    if (plot.cursors.enabled) {
        this._initializeCursorPositionsInView(plot);
        this._ensureCursorBoxDrag(panelId, plot);
        this._syncCursorDisplay(panelId, plot);
        this._refreshActionBtns(panelId);
    } else {
        document.body.classList.remove('cursor-dragging', 'cursor-box-dragging');
        plot.div.style.cursor = '';
        plot.div.closest('.layout-panel')?.classList.remove('cursor-near');
        this._hideCursorOverlay(plot);
        this._hideCursorBox(plot.div.closest('.layout-panel'));
        this._refreshActionBtns(panelId);
    }
};

proto._ensureCursorPositions = function(plot) {
    this._ensureCursorPosition(plot, 'a', 0.25);
    this._ensureCursorPosition(plot, 'b', 0.75);
};

proto._initializeCursorPositionsInView = function(plot) {
    this._initializeCursorPositionInView(plot, 'a', 0.25);
    this._initializeCursorPositionInView(plot, 'b', 0.75);
};

proto._cursorTraceBounds = function(trace) {
    if (!trace) return null;
    const times = this._getTransformedTimeData(trace.fileId);
    if (!times?.length) return null;
    const start = times[0];
    const end = times[times.length - 1];
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return start <= end ? { start, end } : { start: end, end: start };
};

proto._cursorViewBounds = function(plot, trace) {
    const traceBounds = this._cursorTraceBounds(trace);
    if (!traceBounds) return null;
    const range = plot.div?._fullLayout?.xaxis?.range;
    const range0 = this._coerceAxisValue(range?.[0]);
    const range1 = this._coerceAxisValue(range?.[1]);
    const viewStart = Number.isFinite(range0) ? range0 : traceBounds.start;
    const viewEnd = Number.isFinite(range1) ? range1 : traceBounds.end;
    const overlapStart = Math.max(traceBounds.start, Math.min(viewStart, viewEnd));
    const overlapEnd = Math.min(traceBounds.end, Math.max(viewStart, viewEnd));
    if (Number.isFinite(overlapStart) && Number.isFinite(overlapEnd) && overlapStart <= overlapEnd) {
        return { start: overlapStart, end: overlapEnd };
    }
    return traceBounds;
};

proto._coerceAxisValue = function(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const text = String(value).trim();
    const floatingIso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/);
    if (floatingIso) {
        const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '0'] = floatingIso;
        const msPart = Number(String(fraction).padEnd(3, '0').slice(0, 3));
        return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), msPart);
    }
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : NaN;
};

proto._xAxisRangeLock = function(plot) {
    const range = plot?.div?._fullLayout?.xaxis?.range || plot?.div?.layout?.xaxis?.range;
    if (!Array.isArray(range) || range.length < 2) return {};
    return {
        'xaxis.autorange': false,
        'xaxis.range': [range[0], range[1]],
    };
};

proto._clampCursorX = function(plot, which, x) {
    if (!Number.isFinite(x)) return x;
    const trace = this._resolveCursorTrace(plot, which);
    const bounds = this._cursorTraceBounds(trace);
    if (!bounds) return x;
    return Math.max(bounds.start, Math.min(bounds.end, x));
};

proto._ensureCursorPosition = function(plot, which, fraction) {
    if (!plot?.cursors) return;
    const trace = this._resolveCursorTrace(plot, which);
    const bounds = this._cursorViewBounds(plot, trace);
    if (!bounds) return;
    const span = bounds.end - bounds.start;
    const target = bounds.start + (span || 0) * fraction;
    plot.cursors[which] = Number.isFinite(plot.cursors[which])
        ? this._clampCursorX(plot, which, plot.cursors[which])
        : this._clampCursorX(plot, which, target);
};

proto._initializeCursorPositionInView = function(plot, which, fraction) {
    if (!plot?.cursors) return;
    const trace = this._resolveCursorTrace(plot, which);
    const bounds = this._cursorViewBounds(plot, trace);
    if (!bounds) return;
    const span = bounds.end - bounds.start;
    plot.cursors[which] = this._clampCursorX(plot, which, bounds.start + (span || 0) * fraction);
};

proto._resolveCursorTrace = function(plot, which) {
    if (!plot?.traces?.length || !plot.cursors) return null;
    const visibleTraces = plot.traces.filter(t => t.visible !== false && t.visible !== 'legendonly');
    if (!visibleTraces.length) return null;
    const key = which === 'b' ? 'traceB' : 'traceA';
    if (!plot.cursors[key] && plot.cursors.trace) {
        plot.cursors[key] = plot.cursors.trace;
    }
    const preferred = plot.cursors[key];
    if (preferred) {
        const found = visibleTraces.find(t => t.fileId === preferred.fileId && t.varName === preferred.varName);
        if (found) return found;
    }
    const fallback = which === 'b'
        ? (visibleTraces[1] || visibleTraces[0])
        : visibleTraces[0];
    if (fallback) plot.cursors[key] = { fileId: fallback.fileId, varName: fallback.varName };
    return fallback;
};

proto._sameCursorTrace = function(traceA, traceB) {
    return !!(traceA && traceB && traceA.fileId === traceB.fileId && traceA.varName === traceB.varName);
};

proto._cursorShapes = function(plot) {
    if (!plot?.cursors?.enabled) return [];
    const c = plot.cursors;
    if (!Number.isFinite(c.a) || !Number.isFinite(c.b)) return [];
    const traceA = this._resolveCursorTrace(plot, 'a');
    const traceB = this._resolveCursorTrace(plot, 'b');
    const colorA = traceA?.color || '#ff9800';
    const colorB = traceB?.color || '#2196f3';
    const sameTrace = this._sameCursorTrace(traceA, traceB);
    const visualXA = this._cursorPlotlyX(traceA, c.a);
    const visualXB = this._cursorPlotlyX(traceB, c.b);
    const shapes = [
        this._cursorShape(visualXA, colorA, 'solid'),
        this._cursorShape(visualXB, colorB, sameTrace ? 'dash' : 'solid'),
    ];
    const dotPairs = [
        { trace: traceA, x: c.a, color: colorA },
        { trace: traceB, x: c.b, color: colorB },
    ];
    for (const { trace, x, color } of dotPairs) {
        if (!trace) continue;
        const series = this._traceInterpolationSeries(plot, trace);
        if (!series) continue;
        const mode = this._traceInterpolationMode(trace);
        const y = this._interpolateAt(series.times, series.values, x, mode);
        if (!Number.isFinite(y)) continue;
        shapes.push(this._cursorDotShape(this._cursorPlotlyX(trace, x), y, color));
    }
    return shapes;
};

/**
 * Pick the (times, values) arrays the cursor should interpolate over.
 *
 * For DuckDB-lazy-backed files the variable's source `.data` is only a
 * coarse overview (≈ 10 k pts), but Plotly is rendering whatever the most
 * recent lazy refresh streamed in (≈ 4 k pts inside the current viewport).
 * Reading from the overview gives a marker that no longer follows the
 * curve when the user zooms in. So we prefer the rendered trace data
 * (`plot.div.data[i]`) when lazy mode is active.
 *
 * For eager files the source `.data` already has full resolution and the
 * existing min-max-bucket visual downsampler preserves spikes, so we keep
 * the original behavior — interpolating over the source is more accurate
 * between visible samples.
 */
proto._traceInterpolationSeries = function(plot, trace) {
    if (!trace) return null;
    const lazy = !!this.files.get(trace.fileId)?.data?._duckdb;
    if (lazy && plot?.div?.data) {
        const idx = plot.traces.indexOf(trace);
        const rendered = idx >= 0 ? plot.div.data[idx] : null;
        const rx = rendered?.x;
        const ry = rendered?.y;
        if (rx && ry && rx.length === ry.length && rx.length > 0) {
            const times = this._cursorNumericTimes(rx);
            if (times?.length === ry.length) return { times, values: ry };
        }
    }
    const times = this._getTransformedTimeData(trace.fileId);
    const values = this._getTransformedVariableData(trace.fileId, trace.varName);
    if (!times?.length || !values?.length) return null;
    return { times, values };
};

proto._cursorNumericTimes = function(values) {
    if (!values?.length) return values;
    let allNumeric = true;
    for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(Number(values[i]))) {
            allNumeric = false;
            break;
        }
    }
    if (allNumeric) return values;
    const out = new Float64Array(values.length);
    for (let i = 0; i < values.length; i++) {
        out[i] = this._coerceAxisValue(values[i]);
    }
    return out;
};

proto._cursorPlotlyX = function(trace, x) {
    if (!trace) return x;
    return this._plotlyTimeValue(trace.fileId, x, this._getTimeVar(trace.fileId));
};

proto._cursorShape = function(x, color, dash = 'solid') {
    return {
        type: 'line',
        xref: 'x',
        yref: 'paper',
        x0: x,
        x1: x,
        y0: 0,
        y1: 1,
        line: { color, width: 2, dash },
    };
};

proto._cursorDotShape = function(x, y, color) {
    const r = 5;
    return {
        type: 'circle',
        xref: 'x', yref: 'y',
        xsizemode: 'pixel', ysizemode: 'pixel',
        xanchor: x, yanchor: y,
        x0: -r, x1: r, y0: -r, y1: r,
        fillcolor: color,
        line: { color, width: 0 },
    };
};

proto._traceInterpolationMode = function(trace) {
    if (!trace) return 'linear';
    const variable = this.files.get(trace.fileId)?.data?.variables?.[trace.varName];
    if (!variable) return 'linear';
    if (variable.dataType === 'boolean') return 'step';
    return 'linear';
};

proto._findNextExtremum = function(times, values, fromX, type, direction = 'next') {
    const n = Math.min(times?.length || 0, values?.length || 0);
    if (n < 3) return NaN;
    const plateauAt = (i) => {
        const v = values[i];
        if (!Number.isFinite(v)) return null;
        let left = i;
        let right = i;
        while (left > 0 && values[left - 1] === v) left--;
        while (right < n - 1 && values[right + 1] === v) right++;
        if (left === 0 || right === n - 1) return null;
        const before = values[left - 1];
        const after = values[right + 1];
        if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
        if (type === 'max' && v > before && v > after) return { left, right };
        if (type === 'min' && v < before && v < after) return { left, right };
        return null;
    };
    if (direction === 'prev') {
        let i = n - 2;
        while (i >= 1 && times[i] >= fromX) i--;
        while (i >= 1) {
            const plateau = plateauAt(i);
            if (plateau) {
                if (times[plateau.right] < fromX) return times[plateau.right];
                i = plateau.left - 1;
                continue;
            }
            i--;
        }
        return NaN;
    }
    let i = 0;
    while (i < n && times[i] <= fromX) i++;
    if (i < 1) i = 1;
    while (i < n - 1) {
        const plateau = plateauAt(i);
        if (plateau) {
            if (times[plateau.left] > fromX) return times[plateau.left];
            i = plateau.right + 1;
            continue;
        }
        i++;
    }
    return NaN;
};

proto._findNextZeroCrossing = function(times, values, fromX, mode, direction = 'next') {
    const n = Math.min(times?.length || 0, values?.length || 0);
    if (n < 2) return NaN;
    const segmentCrossing = (i) => {
        const v0 = values[i - 1], v1 = values[i];
        const t0 = times[i - 1],  t1 = times[i];
        if (!Number.isFinite(v0) || !Number.isFinite(v1)) return NaN;
        if (!Number.isFinite(t0) || !Number.isFinite(t1)) return NaN;
        if (mode === 'step') {
            return Math.sign(v0) !== Math.sign(v1) ? t1 : NaN;
        }
        if (v1 === 0) return t1;
        if (v0 === 0) return t0;
        if ((v0 < 0 && v1 > 0) || (v0 > 0 && v1 < 0)) {
            return t0 + (-v0) * (t1 - t0) / (v1 - v0);
        }
        return NaN;
    };
    if (direction === 'prev') {
        for (let i = n - 1; i >= 1; i--) {
            const tCross = segmentCrossing(i);
            if (Number.isFinite(tCross) && tCross < fromX) return tCross;
        }
        return NaN;
    }
    for (let i = 1; i < n; i++) {
        const tCross = segmentCrossing(i);
        if (Number.isFinite(tCross) && tCross > fromX) return tCross;
    }
    return NaN;
};

proto._findNextSampleValue = function(times, fromX, direction = 'next') {
    const n = times?.length || 0;
    if (n < 1 || !Number.isFinite(fromX)) return NaN;
    if (direction === 'prev') {
        let lo = 0;
        let hi = n;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (times[mid] < fromX) lo = mid + 1;
            else hi = mid;
        }
        for (let i = lo - 1; i >= 0; i--) {
            if (Number.isFinite(times[i]) && times[i] < fromX) return times[i];
        }
        return NaN;
    }
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= fromX) lo = mid + 1;
        else hi = mid;
    }
    for (let i = lo; i < n; i++) {
        if (Number.isFinite(times[i]) && times[i] > fromX) return times[i];
    }
    return NaN;
};

proto._findCursorTargetInSeries = function(trace, target, times, values, fromX, direction = 'next') {
    if (target === 'max' || target === 'min') {
        return this._findNextExtremum(times, values, fromX, target, direction);
    }
    if (target === 'sample') {
        return this._findNextSampleValue(times, fromX, direction);
    }
    if (target === 'zero') {
        return this._findNextZeroCrossing(times, values, fromX, this._traceInterpolationMode(trace), direction);
    }
    return NaN;
};

proto._findLazyCursorTarget = async function(fileData, trace, cursorX, target, direction = 'next') {
    const source = fileData?._duckdb?.source;
    if (!source?.fetchSourceWindow) return NaN;

    if (typeof source.cancelActiveQuery === 'function') {
        try { await source.cancelActiveQuery(); } catch (_) { /* ignore */ }
    }

    const isSample = target === 'sample';
    const maxRows = isSample ? 2048 : 200000;
    const contextRows = isSample ? 8 : 64;
    const maxAttempts = isSample ? 1 : 8;
    let probe = cursorX;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const chunk = await source.fetchSourceWindow(
            fileData, trace.varName, probe, direction, maxRows, contextRows,
        );
        const times = chunk?.times;
        const values = chunk?.values;
        if (!times?.length) break;

        const found = this._findCursorTargetInSeries(trace, target, times, values, probe, direction);
        if (Number.isFinite(found) && (direction === 'prev' ? found < cursorX : found > cursorX)) {
            return found;
        }

        let nextProbe = NaN;
        if (direction === 'prev') {
            for (let i = 0; i < times.length; i++) {
                if (Number.isFinite(times[i])) { nextProbe = times[i]; break; }
            }
            if (!Number.isFinite(nextProbe) || nextProbe >= probe) break;
        } else {
            for (let i = times.length - 1; i >= 0; i--) {
                if (Number.isFinite(times[i])) { nextProbe = times[i]; break; }
            }
            if (!Number.isFinite(nextProbe) || nextProbe <= probe) break;
        }
        probe = nextProbe;
    }

    return NaN;
};

proto._jumpCursorTo = async function(panelId, which, target, direction = 'next') {
    const plot = this.plots.get(panelId);
    if (!plot?.cursors?.enabled) return;
    const trace = this._resolveCursorTrace(plot, which);
    if (!trace) return;
    const cursorX = plot.cursors[which];
    if (!Number.isFinite(cursorX)) return;

    let times = null;
    let values = null;

    // Lazy-backed file: the overview in `variable.data` is too sparse for
    // these jumps ("next sample" would skip ~150 real samples). Pull a
    // window of *raw* source data from DuckDB instead and run the existing
    // JS detectors on it.
    const fileData = this.files.get(trace.fileId)?.data;
    const lazyMeta = fileData?._duckdb;
    const transformActive = typeof this._isFileTransformActive === 'function'
        && this._isFileTransformActive(this._fileTransform(trace.fileId));
    if (lazyMeta?.source?.fetchSourceWindow && !transformActive) {
        const rendered = this._traceInterpolationSeries(plot, trace);
        const renderedNextX = this._findCursorTargetInSeries(
            trace,
            target,
            rendered?.times,
            rendered?.values,
            cursorX,
            direction,
        );
        if (Number.isFinite(renderedNextX)) {
            plot.cursors[which] = renderedNextX;
            this._syncCursorDisplay(panelId, plot);
            return;
        }

        try {
            const lazyNextX = await this._findLazyCursorTarget(fileData, trace, cursorX, target, direction);
            if (Number.isFinite(lazyNextX)) {
                plot.cursors[which] = lazyNextX;
                this._syncCursorDisplay(panelId, plot);
                return;
            }
        } catch (err) {
            console.warn('[duckdb] cursor jump query failed; falling back to overview:', err?.message || err);
        }
    }

    if (!times) {
        times = this._getTransformedTimeData(trace.fileId);
        values = this._getTransformedVariableData(trace.fileId, trace.varName);
    }

    let nextX = NaN;
    nextX = this._findCursorTargetInSeries(trace, target, times, values, cursorX, direction);
    if (!Number.isFinite(nextX)) return;
    plot.cursors[which] = nextX;
    this._syncCursorDisplay(panelId, plot);
};

proto._panelGuideShapes = function(plot, extra = []) {
    return extra;
};

proto._syncCursorDisplay = function(panelId, plot) {
    if (!plot?.div || plot.mode !== 'timeseries') return;
    if (plot.cursors?.enabled) this._ensureCursorPositions(plot);
    if (plot.cursors?.enabled) this._renderCursorOverlay(plot);
    else this._hideCursorOverlay(plot);
    this._updateCursorBox(panelId, plot);
};

proto._cursorOverlayGeometry = function(plot, trace, x, options = {}) {
    if (!plot?.div || !trace || !Number.isFinite(x)) return null;
    const fl = plot.div._fullLayout;
    const xa = fl?.xaxis;
    const ya = fl?.yaxis;
    if (!xa?.range || !ya?.range || !xa._length || !ya._length) return null;

    const range = Array.isArray(options.range) && options.range.length >= 2
        ? options.range
        : xa.range;
    const x0 = this._coerceAxisValue(range[0]);
    const x1 = this._coerceAxisValue(range[1]);
    const rx = x1 - x0;
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || rx === 0) return null;

    let y = NaN;
    if (!options.lightweight) {
        const series = this._traceInterpolationSeries(plot, trace);
        y = series
            ? this._interpolateAt(series.times, series.values, x, this._traceInterpolationMode(trace))
            : NaN;
    }
    const y0 = Number(ya.range[0]);
    const y1 = Number(ya.range[1]);
    const ry = y1 - y0;

    const left = (xa._offset || 0) + ((x - x0) / rx) * xa._length;
    const leftAxis = xa._offset || 0;
    const rightAxis = leftAxis + xa._length;
    const topAxis = ya._offset || 0;
    const bottomAxis = topAxis + ya._length;
    const top = Number.isFinite(y) && Number.isFinite(y0) && Number.isFinite(y1) && ry !== 0
        ? topAxis + (1 - ((y - y0) / ry)) * ya._length
        : NaN;

    return { left, leftAxis, rightAxis, top, topAxis, bottomAxis, y };
};

proto._cursorSecantClip = function(gA, gB) {
    const x1 = Number(gA?.left);
    const y1 = Number(gA?.top);
    const x2 = Number(gB?.left);
    const y2 = Number(gB?.top);
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;

    const left = Math.max(Number(gA.leftAxis), Number(gB.leftAxis));
    const right = Math.min(Number(gA.rightAxis), Number(gB.rightAxis));
    const top = Math.max(Number(gA.topAxis), Number(gB.topAxis));
    const bottom = Math.min(Number(gA.bottomAxis), Number(gB.bottomAxis));
    if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) return null;

    const dx = x2 - x1;
    const dy = y2 - y1;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null;

    const points = [];
    const eps = 0.5;
    const push = (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        if (x < left - eps || x > right + eps || y < top - eps || y > bottom + eps) return;
        const clamped = {
            x: Math.max(left, Math.min(right, x)),
            y: Math.max(top, Math.min(bottom, y)),
        };
        if (!points.some(p => Math.abs(p.x - clamped.x) < eps && Math.abs(p.y - clamped.y) < eps)) {
            points.push(clamped);
        }
    };

    if (Math.abs(dx) < 1e-9) {
        push(x1, top);
        push(x1, bottom);
    } else {
        for (const x of [left, right]) {
            const t = (x - x1) / dx;
            push(x, y1 + t * dy);
        }
    }

    if (Math.abs(dy) < 1e-9) {
        push(left, y1);
        push(right, y1);
    } else {
        for (const y of [top, bottom]) {
            const t = (y - y1) / dy;
            push(x1 + t * dx, y);
        }
    }

    if (points.length < 2) return null;
    let best = [points[0], points[1]];
    let bestDist = -1;
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const dist = (points[i].x - points[j].x) ** 2 + (points[i].y - points[j].y) ** 2;
            if (dist > bestDist) {
                bestDist = dist;
                best = [points[i], points[j]];
            }
        }
    }
    return { x1: best[0].x, y1: best[0].y, x2: best[1].x, y2: best[1].y };
};

proto._svgNumber = function(value) {
    return Number(value).toFixed(2).replace(/\.?0+$/, '');
};

proto._renderCursorOverlay = function(plot, options = {}) {
    if (!plot?.div || !plot.cursors?.enabled) return;
    if (plot._cursorBoxZoomActive && !options.force) {
        return;
    }
    let overlay = plot.div.querySelector('.cursor-plot-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'cursor-plot-overlay';
        plot.div.appendChild(overlay);
    }

    const traceA = this._resolveCursorTrace(plot, 'a');
    const traceB = this._resolveCursorTrace(plot, 'b');
    const items = [
        { key: 'a', trace: traceA, x: plot.cursors.a, color: traceA?.color || '#ff9800', dash: false },
        { key: 'b', trace: traceB, x: plot.cursors.b, color: traceB?.color || '#2196f3', dash: this._sameCursorTrace(traceA, traceB) },
    ];
    const parts = [];
    const geometries = {};
    for (const item of items) {
        const g = this._cursorOverlayGeometry(plot, item.trace, item.x, options);
        if (!g) continue;
        if (g.left < g.leftAxis || g.left > g.rightAxis) continue;
        geometries[item.key] = g;
        const lineStyle = [
            `left:${g.left}px`,
            `top:${g.topAxis}px`,
            `height:${Math.max(0, g.bottomAxis - g.topAxis)}px`,
            `border-left-color:${item.color}`,
            item.dash ? 'border-left-style:dashed' : '',
        ].filter(Boolean).join(';');
        parts.push(`<div class="cursor-overlay-line cursor-overlay-line-${item.key}" style="${lineStyle}"></div>`);
        if (!options.lightweight && Number.isFinite(g.top) && g.top >= g.topAxis && g.top <= g.bottomAxis) {
            parts.push(`<div class="cursor-overlay-dot cursor-overlay-dot-${item.key}" style="left:${g.left}px;top:${g.top}px;background:${item.color};border-color:${item.color}"></div>`);
        }
    }
    if (!options.lightweight && plot.cursors.showSecant && geometries.a && geometries.b) {
        const secant = this._cursorSecantClip(geometries.a, geometries.b);
        if (secant) {
            const color = this._escapeHTML(traceA?.color || traceB?.color || '#555555');
            parts.unshift(
                `<svg class="cursor-secant-svg" aria-hidden="true" focusable="false">`
                + `<line class="cursor-secant-line" x1="${this._svgNumber(secant.x1)}" y1="${this._svgNumber(secant.y1)}" x2="${this._svgNumber(secant.x2)}" y2="${this._svgNumber(secant.y2)}" stroke="${color}"></line>`
                + `</svg>`
            );
        }
    }
    overlay.innerHTML = parts.join('');
    overlay.style.display = parts.length ? 'block' : 'none';
};

proto._hideCursorOverlay = function(plot) {
    const overlay = plot?.div?.querySelector('.cursor-plot-overlay');
    if (overlay) {
        overlay.style.display = 'none';
        overlay.innerHTML = '';
    }
};

proto._beginCursorBoxZoomSuppress = function(panelId, plot) {
    if (!plot?.div || plot._cursorBoxZoomActive) return;
    plot._cursorBoxZoomActive = true;
    const release = () => {
        document.removeEventListener('mouseup', release, true);
        document.removeEventListener('keydown', cancel, true);
        window.setTimeout(() => {
            plot._cursorBoxZoomActive = false;
            if (plot?.cursors?.enabled) this._syncCursorDisplay(panelId, plot);
        }, 0);
    };
    const cancel = (event) => {
        if (event.key !== 'Escape') return;
        release();
    };
    document.addEventListener('mouseup', release, true);
    document.addEventListener('keydown', cancel, true);
};

proto._eventInsidePlotArea = function(div, event) {
    const fl = div?._fullLayout;
    const xa = fl?.xaxis;
    const ya = fl?.yaxis;
    if (!xa || !ya || !xa._length || !ya._length) return false;
    const rect = div.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const left = xa._offset || 0;
    const right = left + xa._length;
    const top = ya._offset || 0;
    const bottom = top + ya._length;
    return x >= left && x <= right && y >= top && y <= bottom;
};

proto._cursorPairSlideDelta = function(plot, startA, startB, delta) {
    if (!Number.isFinite(delta)) return 0;
    let minDelta = -Infinity;
    let maxDelta = Infinity;
    for (const which of ['a', 'b']) {
        const start = which === 'a' ? startA : startB;
        if (!Number.isFinite(start)) continue;
        const trace = this._resolveCursorTrace(plot, which);
        const bounds = this._cursorTraceBounds(trace);
        if (!bounds) continue;
        minDelta = Math.max(minDelta, bounds.start - start);
        maxDelta = Math.min(maxDelta, bounds.end - start);
    }
    if (minDelta > maxDelta) return 0;
    if (Number.isFinite(minDelta)) delta = Math.max(delta, minDelta);
    if (Number.isFinite(maxDelta)) delta = Math.min(delta, maxDelta);
    return delta;
};

proto._installCursorHandlers = function(panelId, plot) {
    if (!plot?.div || plot._cursorHandlersDiv === plot.div) return;
    if (plot._cursorDocListeners) {
        document.removeEventListener('mousemove', plot._cursorDocListeners.move);
        document.removeEventListener('mouseup',   plot._cursorDocListeners.up);
        plot._cursorDocListeners = null;
    }
    plot._cursorHandlersDiv = plot.div;

    let dragging = null;
    const cursorNearPointer = (event) => {
        if (!plot.cursors?.enabled || plot.mode !== 'timeseries') return null;
        const xa = plot.div?._fullLayout?.xaxis;
        if (!xa || !Number.isFinite(plot.cursors.a) || !Number.isFinite(plot.cursors.b)) return null;
        const x = this._eventToXValue(plot.div, event);
        if (!Number.isFinite(x)) return null;
        const range = xa.range;
        const r0 = this._coerceAxisValue(range?.[0]);
        const r1 = this._coerceAxisValue(range?.[1]);
        const span = Math.abs(r1 - r0) || 1;
        const xLen = Math.abs(xa._length) || 1;
        const tolerance = (5 / xLen) * span;
        const da = Math.abs(x - plot.cursors.a);
        const db = Math.abs(x - plot.cursors.b);
        const near = Math.min(da, db);
        if (near > tolerance) return null;
        return da <= db ? 'a' : 'b';
    };

    plot.div.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        const hit = cursorNearPointer(event);
        if (!hit) {
            if (plot.cursors?.enabled
                && plot.div?._fullLayout?.dragmode !== 'pan'
                && this._eventInsidePlotArea(plot.div, event)) {
                this._beginCursorBoxZoomSuppress(panelId, plot);
            }
            return;
        }
        const x = this._eventToXValue(plot.div, event);
        dragging = event.ctrlKey && Number.isFinite(x)
            ? { mode: 'pair', which: hit, startPointerX: x, startA: plot.cursors.a, startB: plot.cursors.b }
            : { mode: 'single', which: hit };
        event.preventDefault();
        event.stopPropagation();
        document.body.classList.add('cursor-dragging');
    }, true);

    plot.div.addEventListener('mousemove', (event) => {
        if (dragging || !plot.cursors?.enabled) return;
        const near = !!cursorNearPointer(event);
        plot.div.style.cursor = near ? 'ew-resize' : '';
        plot.div.closest('.layout-panel')?.classList.toggle('cursor-near', near);
    });

    plot.div.addEventListener('mouseleave', () => {
        if (!dragging && plot.div) plot.div.style.cursor = '';
        plot.div?.closest('.layout-panel')?.classList.remove('cursor-near');
    });

    const onDocMove = (event) => {
        if (!dragging || !plot.div) return;
        const x = this._eventToXValue(plot.div, event);
        if (!Number.isFinite(x)) return;
        if (dragging.mode === 'pair') {
            const delta = this._cursorPairSlideDelta(plot, dragging.startA, dragging.startB, x - dragging.startPointerX);
            plot.cursors.a = this._clampCursorX(plot, 'a', dragging.startA + delta);
            plot.cursors.b = this._clampCursorX(plot, 'b', dragging.startB + delta);
        } else {
            plot.cursors[dragging.which] = this._clampCursorX(plot, dragging.which, x);
        }
        this._syncCursorDisplay(panelId, plot);
    };
    const onDocUp = () => {
        if (!dragging) return;
        dragging = null;
        document.body.classList.remove('cursor-dragging');
        plot.div?.closest('.layout-panel')?.classList.remove('cursor-near');
    };
    document.addEventListener('mousemove', onDocMove);
    document.addEventListener('mouseup',   onDocUp);
    plot._cursorDocListeners = { move: onDocMove, up: onDocUp };
};

proto._eventToXValue = function(div, event) {
    const xa = div?._fullLayout?.xaxis;
    if (!xa?.range) return NaN;
    const rect = div.getBoundingClientRect();
    const pixel = event.clientX - rect.left - (xa._offset || 0);
    if (typeof xa.p2c === 'function') return this._coerceAxisValue(xa.p2c(pixel));
    const frac = pixel / (xa._length || rect.width || 1);
    const r0 = this._coerceAxisValue(xa.range[0]);
    const r1 = this._coerceAxisValue(xa.range[1]);
    return r0 + frac * (r1 - r0);
};

proto._interpolateAt = function(times, values, x, mode = 'linear') {
    if (!times?.length || !values?.length || !Number.isFinite(x)) return NaN;
    const last = Math.min(times.length, values.length) - 1;
    if (last < 0) return NaN;
    if (x <= times[0]) return values[0];
    if (x >= times[last]) return values[last];
    let lo = 0, hi = last;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= x) lo = mid;
        else hi = mid;
    }
    if (mode === 'step') return values[lo];
    const t0 = times[lo], t1 = times[hi];
    const y0 = values[lo], y1 = values[hi];
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 === t0) return y0;
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return NaN;
    return y0 + (y1 - y0) * ((x - t0) / (t1 - t0));
};

proto._updateCursorBox = function(panelId, plot) {
    const panelEl = plot.div?.closest('.layout-panel');
    if (!panelEl) return;
    if (!plot.cursors?.enabled) {
        this._hideCursorBox(panelEl);
        return;
    }
    const traceA = this._resolveCursorTrace(plot, 'a');
    const traceB = this._resolveCursorTrace(plot, 'b');
    if (!traceA && !traceB) {
        this._showCursorBox(panelEl, i18n.t('cursorsNoTrace'));
        return;
    }
    const aX = plot.cursors.a;
    const bX = plot.cursors.b;
    const measure = (trace, x) => {
        if (!trace) return { y: NaN, timeUnit: 's', yUnit: '', name: '' };
        const series   = this._traceInterpolationSeries(plot, trace);
        const mode     = this._traceInterpolationMode(trace);
        const y        = series
            ? this._interpolateAt(series.times, series.values, x, mode)
            : NaN;
        const timeVar  = this._getTimeVar(trace.fileId);
        const variable = this.files.get(trace.fileId)?.data?.variables?.[trace.varName];
        return {
            y,
            fileId: trace.fileId,
            timeUnit: this._timeUnitLabel(trace.fileId),
            yUnit:    variable ? this._extractUnit(variable.description) : '',
            name:     this._traceName(trace.varName, trace.fileId),
        };
    };
    const a = measure(traceA, aX);
    const b = measure(traceB, bX);
    const dx = bX - aX;
    const isDateTimeCursor = a.timeUnit === 'datetime' || b.timeUnit === 'datetime';
    const isDurationCursor = a.timeUnit === 'duration' || b.timeUnit === 'duration';
    const dxForRate = isDateTimeCursor ? dx / 1000 : dx;
    const dy = b.y - a.y;
    const slope = dxForRate !== 0 ? dy / dxForRate : NaN;
    const inverseDx = dxForRate !== 0 ? 1 / dxForRate : NaN;
    const sameTrace = this._sameCursorTrace(traceA, traceB);
    const sameUnit  = a.yUnit === b.yUnit;
    const timeUnit  = a.timeUnit || b.timeUnit;
    const unit = (u) => u ? ` ${this._escapeHTML(u)}` : '';
    const normalizedTimeUnit = String(timeUnit || '').trim().toLowerCase();
    const inverseTimeUnit = isDateTimeCursor || isDurationCursor
        ? 'Hz'
        : !timeUnit
        ? ''
        : ['s', 'sec', 'secs', 'second', 'seconds'].includes(normalizedTimeUnit)
            ? 'Hz'
            : `1/${timeUnit}`;
    const colorA = traceA?.color || '#ff9800';
    const colorB = traceB?.color || '#2196f3';
    const visibleTraces = plot.traces
        .filter(t => t.visible !== false && t.visible !== 'legendonly');
    const traceKey = (trace) => trace ? `${trace.fileId}\u0000${trace.varName}` : '';
    const optionsKey = visibleTraces
        .map(t => `${t.fileId}\u0000${t.varName}\u0000${t.color || ''}`)
        .join('\u0001');
    const boxSignature = [
        i18n.currentLang,
        optionsKey,
        traceKey(traceA),
        traceKey(traceB),
        colorA,
        colorB,
        sameTrace ? 'same' : 'different',
        plot.cursors.showSecant ? 'secant' : 'no-secant',
    ].join('\u0002');
    const buildOptions = (selectedTrace) => visibleTraces
        .map((t, index) => {
            const selected = selectedTrace && t.fileId === selectedTrace.fileId && t.varName === selectedTrace.varName ? ' selected' : '';
            const color = this._escapeHTML(t.color || '#333333');
            return `<option value="${index}"${selected} style="color:${color}">${this._escapeHTML(this._traceName(t.varName, t.fileId))}</option>`;
        })
        .join('');
    const traceLabel = this._escapeHTML(i18n.t('cursorTraceLabel'));
    const maxIcon  = `<svg viewBox="0 0 16 12" width="12" height="10" aria-hidden="true" focusable="false"><path d="M1 11 Q 8 0 15 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    const minIcon  = `<svg viewBox="0 0 16 12" width="12" height="10" aria-hidden="true" focusable="false"><path d="M1 1 Q 8 12 15 1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    const zeroIcon = `<svg viewBox="0 0 16 12" width="12" height="10" aria-hidden="true" focusable="false"><path d="M1 6 H 15" stroke="currentColor" stroke-width="0.8" opacity="0.55" fill="none"/><path d="M2.5 1.5 Q 6 6 8 6 Q 10 6 13.5 10.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/><circle cx="8" cy="6" r="1.4" fill="currentColor"/></svg>`;
    const sampleIcon = `<svg viewBox="0 0 16 12" width="12" height="10" aria-hidden="true" focusable="false"><path d="M2 6 H10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M8 3 L11 6 L8 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="13" cy="6" r="1.6" fill="currentColor"/></svg>`;
    const maxTitle  = this._escapeHTML(i18n.t('cursorNextMax'));
    const minTitle  = this._escapeHTML(i18n.t('cursorNextMin'));
    const zeroTitle = this._escapeHTML(i18n.t('cursorNextZero'));
    const sampleTitle = this._escapeHTML(i18n.t('cursorNextValue'));
    const shiftHint = this._escapeHTML(i18n.t('cursorShiftPreviousHint'));
    const slideHint = this._escapeHTML(i18n.t('cursorSlideBothHint'));
    const labelX = this._escapeHTML(i18n.t('cursorLabelX'));
    const labelY = this._escapeHTML(i18n.t('cursorLabelY'));
    const labelDx = this._escapeHTML(i18n.t('cursorLabelDeltaX'));
    const labelDy = this._escapeHTML(i18n.t('cursorLabelDeltaY'));
    const labelSlope = this._escapeHTML(i18n.t('cursorLabelSlope'));
    const labelInvDx = this._escapeHTML(i18n.t('cursorLabelInverseDeltaX'));
    const secantLabel = this._escapeHTML(i18n.t('cursorSecantLine'));
    const secantChecked = plot.cursors.showSecant ? ' checked' : '';
    const buildExtremaBtns = (which, color) => `
        <button type="button" class="cursor-extremum-btn" data-cursor="${which}" data-target="max"  style="color:${color}" title="${maxTitle} (${which.toUpperCase()}) | ${shiftHint}"  aria-label="${maxTitle} (${which.toUpperCase()}) | ${shiftHint}">${maxIcon}</button>
        <button type="button" class="cursor-extremum-btn" data-cursor="${which}" data-target="min"  style="color:${color}" title="${minTitle} (${which.toUpperCase()}) | ${shiftHint}"  aria-label="${minTitle} (${which.toUpperCase()}) | ${shiftHint}">${minIcon}</button>
        <button type="button" class="cursor-extremum-btn" data-cursor="${which}" data-target="zero" style="color:${color}" title="${zeroTitle} (${which.toUpperCase()}) | ${shiftHint}" aria-label="${zeroTitle} (${which.toUpperCase()}) | ${shiftHint}">${zeroIcon}</button>
        <button type="button" class="cursor-extremum-btn" data-cursor="${which}" data-target="sample" style="color:${color}" title="${sampleTitle} (${which.toUpperCase()}) | ${shiftHint}" aria-label="${sampleTitle} (${which.toUpperCase()}) | ${shiftHint}">${sampleIcon}</button>
    `;
    const selectorsHTML = `
        <label class="cursor-trace-select" data-cursor="a">
            <span><b style="color:${colorA}">A</b> ${traceLabel}</span>
            <select>${buildOptions(traceA)}</select>
            ${buildExtremaBtns('a', colorA)}
        </label>
        <label class="cursor-trace-select" data-cursor="b">
            <span><b style="color:${colorB}">B</b> ${traceLabel}</span>
            <select>${buildOptions(traceB)}</select>
            ${buildExtremaBtns('b', colorB)}
        </label>
    `;
    const secantHTML = `
        <label class="cursor-secant-toggle">
            <input type="checkbox" class="cursor-secant-checkbox"${secantChecked}>
            <span>${secantLabel}</span>
        </label>
    `;
    const moveIcon = `<svg class="cursor-info-move-icon" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M13 6V11H18V7.75L22.25 12L18 16.25V13H13V18H16.25L12 22.25L7.75 18H11V13H6V16.25L1.75 12L6 7.75V11H11V6H7.75L12 1.75L16.25 6H13Z"/></svg>`;
    const valuesHTML = `
            <div><b style="color:${colorA}">A</b> ${labelX}=${this._escapeHTML(this._formatTimeValue(a.fileId, aX))}${(isDateTimeCursor || isDurationCursor) ? '' : unit(timeUnit)} ${labelY}=${this._formatHTMLNumber(a.y)}${unit(a.yUnit)}</div>
            <div><b style="color:${colorB}">B</b> ${labelX}=${this._escapeHTML(this._formatTimeValue(b.fileId, bX))}${(isDateTimeCursor || isDurationCursor) ? '' : unit(timeUnit)} ${labelY}=${this._formatHTMLNumber(b.y)}${unit(b.yUnit)}</div>
            <div><b>${labelDx}=</b>${this._escapeHTML(isDateTimeCursor ? this._formatDuration(dx, 'datetime') : (isDurationCursor ? this._formatDuration(dx, 's') : this._formatHTMLNumber(dx)))}${(isDateTimeCursor || isDurationCursor) ? '' : unit(timeUnit)}</div>
            <div><b>${labelDy}=</b>${this._formatHTMLNumber(dy)}${sameUnit ? unit(a.yUnit) : ''}</div>
            <div><b>${labelSlope}=</b>${this._formatHTMLNumber(slope)}</div>
            <div><b>${labelInvDx}=</b>${this._formatHTMLNumber(inverseDx)}${unit(inverseTimeUnit)}</div>
    `;
    const existingBox = panelEl.querySelector('.cursor-info-box');
    if (existingBox?.dataset.cursorSignature === boxSignature) {
        const valuesEl = existingBox.querySelector('.cursor-info-values');
        if (valuesEl) valuesEl.innerHTML = valuesHTML;
        this._applyCursorBoxPosition(panelEl, existingBox, plot);
        existingBox.style.display = 'block';
        return;
    }
    const html = `
        <div class="cursor-info-header">
            <span class="cursor-info-title">${moveIcon}${this._escapeHTML(i18n.t('cursorsToggle'))}</span>
        </div>
        ${selectorsHTML}
        ${secantHTML}
        <div class="cursor-info-hint">
            <div>${shiftHint}</div>
            <div>${slideHint}</div>
        </div>
        <div class="cursor-info-values">
            ${valuesHTML}
        </div>
    `;
    const box = this._showCursorBox(panelEl, html, panelId, plot);
    if (box) box.dataset.cursorSignature = boxSignature;
};

proto._showCursorBox = function(panelEl, html, panelId = null, plot = null) {
    let box = panelEl.querySelector('.cursor-info-box');
    if (!box) {
        box = document.createElement('div');
        box.className = 'cursor-info-box';
        panelEl.appendChild(box);
    }
    box.innerHTML = html;
    if (panelId && plot) {
        box.querySelectorAll('.cursor-trace-select').forEach(label => {
            const which = label.getAttribute('data-cursor');
            const select = label.querySelector('select');
            if (!select || (which !== 'a' && which !== 'b')) return;
            const syncSelectColor = () => {
                const option = select.options[select.selectedIndex];
                select.style.color = option?.style?.color || '';
            };
            syncSelectColor();
            select.addEventListener('change', (event) => {
                const visibleTraces = plot.traces
                    .filter(t => t.visible !== false && t.visible !== 'legendonly');
                const selectedTrace = visibleTraces[Number(event.target.value)];
                if (!selectedTrace) return;
                const key = which === 'b' ? 'traceB' : 'traceA';
                plot.cursors[key] = { fileId: selectedTrace.fileId, varName: selectedTrace.varName };
                plot.cursors[which] = this._clampCursorX(plot, which, plot.cursors[which]);
                syncSelectColor();
                this._syncCursorDisplay(panelId, plot);
            });
        });
        box.querySelectorAll('.cursor-extremum-btn').forEach(btn => {
            const which  = btn.getAttribute('data-cursor');
            const target = btn.getAttribute('data-target');
            if ((which !== 'a' && which !== 'b') || !['max', 'min', 'zero', 'sample'].includes(target)) return;
            btn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const direction = e.shiftKey ? 'prev' : 'next';
                this._jumpCursorTo(panelId, which, target, direction);
            });
        });
        const secantCheckbox = box.querySelector('.cursor-secant-checkbox');
        if (secantCheckbox) {
            secantCheckbox.addEventListener('change', (e) => {
                e.stopPropagation();
                plot.cursors.showSecant = !!e.target.checked;
                this._syncCursorDisplay(panelId, plot);
            });
        }
    }
    if (panelId && plot) this._ensureCursorBoxDrag(panelId, plot);
    this._applyCursorBoxPosition(panelEl, box, plot);
    box.style.display = 'block';
    return box;
};

proto._applyCursorBoxPosition = function(panelEl, box, plot) {
    const pos = plot?.cursors?.boxPos;
    if (!pos) return;
    box.style.left = `${pos.x}px`;
    box.style.top = `${pos.y}px`;
    box.style.right = 'auto';
};

proto._ensureCursorBoxDrag = function(panelId, plot) {
    const panelEl = plot.div?.closest('.layout-panel');
    const box = panelEl?.querySelector('.cursor-info-box');
    if (!panelEl || !box || box._dragBound) return;
    box._dragBound = true;
    let drag = null;

    box.addEventListener('mousedown', (event) => {
        if (!event.target.closest('.cursor-info-header')) return;
        event.preventDefault();
        event.stopPropagation();
        const panelRect = panelEl.getBoundingClientRect();
        const boxRect = box.getBoundingClientRect();
        drag = {
            offsetX: event.clientX - boxRect.left,
            offsetY: event.clientY - boxRect.top,
            panelRect,
        };
        document.body.classList.add('cursor-box-dragging');
    });

    document.addEventListener('mousemove', (event) => {
        if (!drag) return;
        const rect = panelEl.getBoundingClientRect();
        const maxX = Math.max(0, rect.width - box.offsetWidth - 6);
        const maxY = Math.max(0, rect.height - box.offsetHeight - 6);
        const x = Math.max(6, Math.min(maxX, event.clientX - rect.left - drag.offsetX));
        const y = Math.max(6, Math.min(maxY, event.clientY - rect.top - drag.offsetY));
        plot.cursors.boxPos = { x, y };
        this._applyCursorBoxPosition(panelEl, box, plot);
    });

    document.addEventListener('mouseup', () => {
        if (!drag) return;
        drag = null;
        document.body.classList.remove('cursor-box-dragging');
    });
};

proto._hideCursorBox = function(panelEl) {
    const box = panelEl?.querySelector('.cursor-info-box');
    if (box) box.style.display = 'none';
};

/** Add hidden marker trace(s) for hover sync. Called once after newPlot. */
proto._initMarkerTrace = function(plot) {
    if (!plot.div) return;

    if (plot.mode === 'timeseries') {
        plot.markerTraceIdx = null;
    } else if (plot.mode === 'phase2d') {
        const traces = plot.phaseTraces.map(pt => ({
            x: [null], y: [null], type: 'scatter', mode: 'markers',
            marker: { size: 10, color: pt.color, line: { color: '#fff', width: 1.5 } },
            showlegend: false, hoverinfo: 'skip', visible: false, name: '__hover__',
        }));
        if (!traces.length) return;
        Plotly.addTraces(plot.div, traces).then(() => {
            const n = plot.div.data.length;
            plot.markerTraceIdx = traces.map((_, i) => n - traces.length + i);
        });
    } else if (plot.mode === 'phase2dt' || plot.mode === 'phase3d') {
        const traces = plot.phaseTraces.map(pt => ({
            x: [null], y: [null], z: [null], type: 'scatter3d', mode: 'markers',
            marker: { size: 5, color: pt.color, line: { color: '#fff', width: 1 } },
            showlegend: false, hoverinfo: 'skip', visible: false, name: '__hover__',
        }));
        if (!traces.length) return;
        Plotly.addTraces(plot.div, traces).then(() => {
            const n = plot.div.data.length;
            plot.markerTraceIdx = traces.map((_, i) => n - traces.length + i);
        });
    }
};

proto._syncTimeseriesMarkerColors = function(plot) {
    if (!plot?.div || plot.mode !== 'timeseries' || !Number.isInteger(plot.markerTraceIdx)) return;
    Plotly.restyle(plot.div, { 'marker.color': [plot.traces.map(t => t.color)] }, [plot.markerTraceIdx]);
};

proto._addOneMarkerTrace = function(plot, pt) {
    if (!plot.div || !pt) return;
    const is3d = plot.mode === 'phase2dt' || plot.mode === 'phase3d';
    const trace = is3d
        ? { x: [null], y: [null], z: [null], type: 'scatter3d', mode: 'markers',
            marker: { size: 5, color: pt.color, line: { color: '#fff', width: 1 } },
            showlegend: false, hoverinfo: 'skip', visible: false, name: '__hover__' }
        : { x: [null], y: [null], type: 'scatter', mode: 'markers',
            marker: { size: 10, color: pt.color, line: { color: '#fff', width: 1.5 } },
            showlegend: false, hoverinfo: 'skip', visible: false, name: '__hover__' };
    Plotly.addTraces(plot.div, trace).then(() => {
        const newIdx = plot.div.data.length - 1;
        if (plot.markerTraceIdx == null) {
            plot.markerTraceIdx = [newIdx];
        } else {
            plot.markerTraceIdx = [...(Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx : [plot.markerTraceIdx]), newIdx];
        }
    });
};

// ─── 3D camera views ───────────────────────────────────────────

proto._updateCameraOverlay = function(plot) {
    if (!plot?.cameraOverlayEl || !plot.div) return;
    const camera = plot.div._fullLayout?.scene?.camera || plot.div.layout?.scene?.camera || {};
    const projection = camera.projection?.type || plot.projection || 'orthographic';
    const eye = camera.eye || { x: 1.25, y: 1.25, z: 1.25 };
    const up = camera.up || { x: 0, y: 0, z: 1 };
    const center = camera.center || { x: 0, y: 0, z: 0 };
    const fmtObj = (obj) => `{ x: ${this._fmtCameraNumber(obj.x)}, y: ${this._fmtCameraNumber(obj.y)}, z: ${this._fmtCameraNumber(obj.z)} }`;

    plot.cameraOverlayEl.textContent =
        `camera\n` +
        `projection: ${projection}\n` +
        `eye: ${fmtObj(eye)}\n` +
        `up: ${fmtObj(up)}\n` +
        `center: ${fmtObj(center)}`;
};

proto._fmtCameraNumber = function(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return n.toFixed(4).replace(/\.?0+$/, '');
};

proto._setCamera = function(panelId, preset) {
    const plot = this.plots.get(panelId);
    if (!plot?.div) return;
    // Plotly's own default is eye=(1.25,1.25,1.25), up=(0,0,1).
    // phase2dt rotates the home eye around the Z (up) axis so time (plotly X) reads
    // from lower-right toward upper-left, var x (plotly Y) toward lower-left, var y up.
    const is2dt = plot.mode === 'phase2dt';
    const cameras = {
        home:  plot.homeCamera || (is2dt
            ? { eye: { x: 1.25, y: -1.25, z: 1.25 }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } }
            : { eye: { x: 1.25, y:  1.25, z: 1.25 }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } }),
        top:   { eye: { x: 0, y: 0, z: 2 }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } },
        front: { eye: { x: 0,    y: -2,   z: 0    }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
        yz:    { eye: { x: 2,    y: 0,    z: 0    }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
    };
    const cam = cameras[preset] || cameras.home;
    const layoutUpdate = {
        'scene.camera': { ...cam, projection: { type: plot.projection || 'orthographic' } },
    };
    // Note: don't re-enable autorange here — explicit ranges (set at layout-build time
    // and including origin) are what lets the origin-anchored axis lines render at
    // equal visual length. Re-enabling autorange would let the axis lines themselves
    // expand the scene and break that property.
    Plotly.relayout(plot.div, layoutUpdate).then(() => this._updateCameraOverlay(plot));
};

proto._toggleProjection = function(panelId, panelEl) {
    const plot = this.plots.get(panelId);
    if (!plot) return;
    plot.projection = plot.projection === 'orthographic' ? 'perspective' : 'orthographic';
    if (plot.div) {
        Plotly.relayout(plot.div, { 'scene.camera.projection.type': plot.projection })
            .then(() => this._updateCameraOverlay(plot));
    }
    const projBtn = panelEl.querySelector('.proj-btn');
    if (projBtn) {
        const isOrtho = plot.projection === 'orthographic';
        projBtn.classList.toggle('active', isOrtho);
        projBtn.title = i18n.t(isOrtho ? 'projIsometric' : 'projPerspective');
    }
};

/**
 * Animate a 90° (or arbitrary angle) rotation of the 3D camera around an axis.
 * axis: 'x', 'y', or 'z'
 * angle: radians to rotate (e.g. Math.PI/2)
 * duration: animation duration in ms
 */
proto._animateRotation = function(panelId, axis, angle, duration) {
    const plot = this.plots.get(panelId);
    if (!plot?.div) return;

    // Read current camera
    const cam = plot.div.layout?.scene?.camera || {};
    const eye0 = { ...(cam.eye || { x: 1.25, y: 1.25, z: 1.25 }) };
    const up0  = { ...(cam.up  || { x: 0, y: 0, z: 1 }) };
    const center = cam.center || { x: 0, y: 0, z: 0 };

    const rotateVec = (v, theta) => {
        const c = Math.cos(theta), s = Math.sin(theta);
        switch (axis) {
            case 'x': return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c };
            case 'y': return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
            case 'z': return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
        }
    };

    // Relative eye vector (eye - center)
    const rel0 = { x: eye0.x - center.x, y: eye0.y - center.y, z: eye0.z - center.z };

    const startTime = performance.now();
    const step = () => {
        const elapsed = performance.now() - startTime;
        const t = Math.min(elapsed / duration, 1);
        // Ease in-out
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const theta = angle * ease;

        const rel = rotateVec(rel0, theta);
        const up  = rotateVec(up0, theta);

        Plotly.relayout(plot.div, {
            'scene.camera.eye': { x: center.x + rel.x, y: center.y + rel.y, z: center.z + rel.z },
            'scene.camera.up': up,
        });

        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
};

// ─── Mode buttons injected into panel toolbar ──────────────────

proto._injectModeButtons = function(panelId, panelEl, currentMode) {
    const toolbar = panelEl.querySelector('.layout-panel-toolbar');
    if (!toolbar) return;

    // Remove existing mode buttons if any (re-render case)
    toolbar.querySelectorAll('.mode-btn-group, .view-btn-group').forEach(el => el.remove());
    toolbar.querySelectorAll('.panel-action-btn').forEach(el => el.remove());

    const plot = this.plots.get(panelId);

    // Mode toggle group
    const modeGroup = document.createElement('div');
    modeGroup.className = 'mode-btn-group';

    const modes = [
        { id: 'timeseries', label: '📈', titleKey: 'modeTimeseries' },
        { id: 'phase2d',    label: '2D',  titleKey: 'modePhase2d'   },
        { id: 'phase2dt',   label: '2D+t',titleKey: 'modePhase2dt'  },
        { id: 'phase3d',    label: '3D',     titleKey: 'modePhase3d'   },
        { id: 'state-anim', label: '▶x 2D',  titleKey: 'modeStateAnim2d', stateAnimDim: 2 },
        { id: 'state-anim', label: '▶x 3D',  titleKey: 'modeStateAnim3d', stateAnimDim: 3 },
    ];
    modes.forEach(m => {
        const btn = document.createElement('button');
        const isActive = m.id === currentMode && (m.id !== 'state-anim' || (plot?.stateAnimDim || 2) === m.stateAnimDim);
        btn.className = 'layout-toolbar-btn mode-btn' + (isActive ? ' active' : '');
        btn.textContent = m.label;
        btn.dataset.mode = m.id;
        if (m.stateAnimDim) btn.dataset.stateAnimDim = String(m.stateAnimDim);
        btn.title = i18n.t(m.titleKey);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._requestModeChange(panelId, m.id, m.stateAnimDim || null);
        });
        modeGroup.appendChild(btn);
    });
    toolbar.appendChild(modeGroup);

    // 3D view buttons (visible only in 3D modes)
    const viewGroup = document.createElement('div');
    viewGroup.className = 'view-btn-group';
    viewGroup.style.display = this._is3D(currentMode) ? '' : 'none';

    const is2dt = currentMode === 'phase2dt';
    const views = [
        { preset: 'home',  label: '⌂',                titleKey: 'viewHome'  },
        { preset: 'top',   label: is2dt ? 'x vs t' : 'XY', titleKey: is2dt ? 'view2dtXt' : 'viewTop'   },
        { preset: 'front', label: is2dt ? 'y vs t' : 'XZ', titleKey: is2dt ? 'view2dtYt' : 'viewFront' },
        { preset: 'yz',    label: is2dt ? 'y vs x' : 'YZ', titleKey: is2dt ? 'view2dtXY' : 'viewSide'  },
    ];

    views.forEach(v => {
        const btn = document.createElement('button');
        btn.className = 'layout-toolbar-btn view-btn' + (v.preset !== 'home' ? ' view-btn-3d-only' : '');
        btn.textContent = v.label;
        btn.title = i18n.t(v.titleKey);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (v.preset === 'home') {
                // Home performs a true autoscale in every mode.
                const p = this.plots.get(panelId);
                this._autoScalePlot(panelId, p);
            } else {
                this._setCamera(panelId, v.preset === 'yz' ? 'yz' : v.preset);
            }
        });
        viewGroup.appendChild(btn);
    });

    // Projection toggle button (Iso / Persp)
    const isOrtho = !plot || plot.projection === 'orthographic';
    const projBtn = document.createElement('button');
    projBtn.className = 'layout-toolbar-btn view-btn proj-btn view-btn-3d-only' + (isOrtho ? ' active' : '');
    projBtn.textContent = 'Iso';
    projBtn.title = i18n.t(isOrtho ? 'projIsometric' : 'projPerspective');
    projBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleProjection(panelId, panelEl);
    });
    viewGroup.appendChild(projBtn);

    // Rotation buttons (90° animated rotation around each axis)
    const rotAxes = [
        { axis: 'z', label: '⟳Z', title: 'Rotate 90° around Z' },
        { axis: 'x', label: '⟳X', title: 'Rotate 90° around X' },
        { axis: 'y', label: '⟳Y', title: 'Rotate 90° around Y' },
    ];
    rotAxes.forEach(r => {
        const btn = document.createElement('button');
        btn.className = 'layout-toolbar-btn view-btn view-btn-3d-only rot-btn';
        btn.textContent = r.label;
        btn.title = r.title;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._animateRotation(panelId, r.axis, Math.PI / 2, 400);
        });
        viewGroup.appendChild(btn);
    });

    toolbar.appendChild(viewGroup);

    if (this._supportsEqualAspect2D(plot)) {
        const equalAspectBtn = document.createElement('button');
        equalAspectBtn.className = 'layout-toolbar-btn panel-action-btn equal-aspect-btn' + (plot?.equalAspect2D ? ' active' : '');
        equalAspectBtn.textContent = '1:1';
        equalAspectBtn.title = i18n.t('equalAspect2D');
        equalAspectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleEqualAspect2D(panelId);
        });
        toolbar.appendChild(equalAspectBtn);
    }

    // Compare (overlay traces from other files) — left of CSV
    const compareBtn = document.createElement('button');
    compareBtn.className = 'layout-toolbar-btn panel-action-btn compare-files-btn';
    compareBtn.textContent = '⧉';
    compareBtn.title = i18n.t('compareFiles');
    const canCompare = this._hasContent(plot)
        && plot.mode !== 'state-anim'
        && this.files.size > 1;
    compareBtn.disabled = !canCompare;
    compareBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._compareAcrossFiles(panelId);
    });
    toolbar.appendChild(compareBtn);

    const cursorBtn = document.createElement('button');
    cursorBtn.className = 'layout-toolbar-btn panel-action-btn cursor-btn' + (plot?.cursors?.enabled ? ' active' : '');
    cursorBtn.textContent = 'A|B';
    cursorBtn.title = i18n.t('cursorsToggle');
    cursorBtn.disabled = !(this._hasContent(plot) && plot?.mode === 'timeseries');
    cursorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleCursors(panelId);
    });
    toolbar.appendChild(cursorBtn);

    // Quick numeric summary for reports and lab analysis
    const statsBtn = document.createElement('button');
    statsBtn.className = 'layout-toolbar-btn panel-action-btn panel-stats-btn';
    statsBtn.textContent = 'Σ';
    statsBtn.title = i18n.t('panelStats');
    statsBtn.disabled = !this._hasContent(plot);
    statsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._showPanelStats(panelId);
    });
    toolbar.appendChild(statsBtn);

    // CSV export button - pushed to far right, 🗑️ follows immediately after
    const csvBtn = document.createElement('button');
    csvBtn.className = 'layout-toolbar-btn panel-action-btn csv-export-btn';
    csvBtn.textContent = 'CSV';
    csvBtn.title = i18n.t('exportCsv');
    csvBtn.disabled = !this._hasContent(plot);
    csvBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._exportCSV(panelId);
    });
    toolbar.appendChild(csvBtn);

    // Clear button — immediately right of CSV
    const clearBtn = document.createElement('button');
    clearBtn.className = 'layout-toolbar-btn panel-action-btn trash-panel-btn';
    clearBtn.textContent = '🗑️';
    clearBtn.title = i18n.t('clearPlot');
    clearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._clearPanel(panelId);
    });
    toolbar.appendChild(clearBtn);
};

proto._requestModeChange = function(panelId, mode, stateAnimDim = null) {
    const plot = this.plots.get(panelId);
    if (!plot) return;
    const nextDim = mode === 'state-anim' ? (stateAnimDim || plot.stateAnimDim || 2) : plot.stateAnimDim;
    if (plot.mode === mode && plot.stateAnimDim === nextDim) {
        this._dismissModeChangeWarning(panelId);
        return;
    }
    if (!this._hasContent(plot)) {
        this._setMode(panelId, mode, stateAnimDim);
        return;
    }
    this._showModeChangeWarning(panelId, mode, stateAnimDim);
};

proto._showModeChangeWarning = function(panelId, mode, stateAnimDim = null) {
    const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
    if (!panelEl) return;

    panelEl.querySelector('.mode-change-warning-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'mode-change-warning-overlay';
    overlay.addEventListener('click', e => e.stopPropagation());
    overlay.addEventListener('pointerdown', e => e.stopPropagation());
    overlay.addEventListener('pointermove', e => e.stopPropagation());
    overlay.addEventListener('wheel', e => {
        e.preventDefault();
        e.stopPropagation();
    }, { passive: false });

    const warning = document.createElement('div');
    warning.className = 'mode-change-warning';
    warning.setAttribute('role', 'status');
    warning.addEventListener('click', e => e.stopPropagation());

    const text = document.createElement('div');
    text.className = 'mode-change-warning-text';
    text.dataset.i18n = 'modeChangeClearsTracesWarning';
    text.textContent = i18n.t('modeChangeClearsTracesWarning');
    warning.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'mode-change-warning-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'mode-change-warning-btn';
    cancelBtn.dataset.i18n = 'cancel';
    cancelBtn.textContent = i18n.t('cancel');
    cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._dismissModeChangeWarning(panelId);
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'mode-change-warning-btn confirm';
    confirmBtn.dataset.i18n = 'modeChangeConfirm';
    confirmBtn.textContent = i18n.t('modeChangeConfirm');
    confirmBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._dismissModeChangeWarning(panelId);
        this._setMode(panelId, mode, stateAnimDim);
    });

    actions.append(cancelBtn, confirmBtn);
    warning.appendChild(actions);
    overlay.appendChild(warning);
    panelEl.appendChild(overlay);
};

proto._dismissModeChangeWarning = function(panelId) {
    const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
    panelEl?.querySelector('.mode-change-warning-overlay')?.remove();
};

proto._updateModeButtons = function(panelEl, activeMode) {
    const panelId = panelEl.dataset.id;
    const plot = panelId ? this.plots.get(panelId) : null;
    panelEl.querySelectorAll('.mode-btn').forEach(btn => {
        const mode = btn.dataset.mode;
        const dim = btn.dataset.stateAnimDim ? Number(btn.dataset.stateAnimDim) : null;
        btn.classList.toggle('active', mode === activeMode && (!dim || dim === (plot?.stateAnimDim || 2)));
    });
};

proto._toggle3DViewButtons = function(panelEl, show) {
    const group = panelEl.querySelector('.view-btn-group');
    if (group) group.style.display = show ? '' : 'none';
};

proto._supportsEqualAspect2D = function(plot) {
    return !!plot && (plot.mode === 'phase2d' || (plot.mode === 'state-anim' && (plot.stateAnimDim || 2) === 2));
};

proto._toggleEqualAspect2D = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!this._supportsEqualAspect2D(plot)) return;
    plot.equalAspect2D = !plot.equalAspect2D;
    if (plot.div) {
        const update = plot.equalAspect2D
            ? { 'yaxis.scaleanchor': 'x', 'yaxis.scaleratio': 1 }
            : { 'yaxis.scaleanchor': null, 'yaxis.scaleratio': null, 'xaxis.autorange': true, 'yaxis.autorange': true };
        Plotly.relayout(plot.div, update);
    }
    const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
    const btn = panelEl?.querySelector('.equal-aspect-btn');
    if (btn) btn.classList.toggle('active', plot.equalAspect2D);
};

// ─── Placeholder text ──────────────────────────────────────────

proto._updatePlaceholder = function(panelId, panelEl) {
    const placeholder = panelEl.querySelector('.layout-panel-placeholder');
    if (!placeholder) return;

    const plot = this.plots.get(panelId);
    // If plot has content, placeholder is hidden — nothing to update
    if (plot && this._hasContent(plot)) return;

    const mode = plot ? plot.mode : 'timeseries';
    const pp   = plot ? plot.phasePending : { x: null, y: null, z: null };

    let msg;
    switch (mode) {
        case 'state-anim': {
            const sx = plot ? (plot.stateSlots?.x || []) : [];
            const dim = plot ? (plot.stateAnimDim || 2) : 2;
            msg = sx.length === 0 ? (dim === 3 ? i18n.t('dropState3dMulti') : i18n.t('dropState2dMulti'))
                : sx.length === 1 ? i18n.t('dropStateX2Short')
                : dim === 3 ?        i18n.t('dropStateX3')
                :                    i18n.t('dropVariableHere');
            break;
        }
        case 'phase2d':
            msg = !pp.x ? i18n.t('dropPhase2dMulti') : i18n.t('dropY');
            break;
        case 'phase2dt':
            msg = !pp.x ? i18n.t('dropPhase2dtMulti') : i18n.t('dropYAutoTime');
            break;
        case 'phase3d':
            msg = !pp.x ? i18n.t('dropPhase3dMulti')
                : !pp.y ? i18n.t('dropY')
                :         i18n.t('dropZ');
            break;
        default: // timeseries
            msg = i18n.t('dropTimeseriesMulti');
    }
    placeholder.innerHTML = `
        <span>${msg}</span>
        <small class="layout-panel-placeholder-hint">${formatPlaceholderHint('multiSelectHint')}</small>
        <small class="layout-panel-placeholder-hint">${formatPlaceholderHint('legendHint')}</small>
    `;
};

// ─── Helpers ───────────────────────────────────────────────────

}
