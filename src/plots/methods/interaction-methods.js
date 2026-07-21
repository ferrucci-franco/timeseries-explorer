import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';
import { formatSpectrumPeriod, spectrumCursorMeasurements } from '../../utils/fft.js';
import { missingBucketsToIntervals } from '../../data/missing-buckets-sql.js';

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
    const plot = this.plots.get(sourcePanelId);
    const update = this._xAxisUpdateFromRelayout(eventData, plot);
    if (!update) return;

    if (this._syncing && sourcePanelId !== this._syncSourcePanelId) {
        return;
    }

    if (plot?._relayoutLiveOnly) {
        this._onRelayouting(sourcePanelId, eventData);
        return;
    }
    this._clearRelayoutingRefresh(plot);

    if (plot?.mode === 'timeseries' || plot?.mode === 'fft' || plot?.mode === 'histogram' || plot?.mode === 'heatmap' || plot?.mode === 'temporal-profile') {
        const autorangeRequested = update['xaxis.autorange'] === true
            || eventData?.['yaxis.autorange'] === true
            || eventData?.['yaxis2.autorange'] === true;
        if (autorangeRequested) {
            // FFT: the relayout comes from the time sub-plot; leave the
            // spectrum axes (and manual fMin/fMax/yMin/yMax) untouched.
            if (plot.mode === 'fft' || plot.mode === 'histogram' || plot.mode === 'heatmap' || plot.mode === 'temporal-profile') this._autoScalePlotTimeOnly(plot);
            else this._autoScalePlot(sourcePanelId, plot);
        } else {
            const visibleRange = Array.isArray(update['xaxis.range']) ? update['xaxis.range'] : null;
            this._refreshTimeseriesVisuals(sourcePanelId, plot, visibleRange);
        }
        if (plot.mode === 'fft') {
            // Keep the windowed overlay downsampled to the same visible window
            // as the real signals (it is an extra trace, so the restyle above
            // does not reach it).
            this._refreshFftWindowedVisuals?.(sourcePanelId, plot, this._fftCurrentVisibleRange?.(plot));
            this._updateFftSelectionShapes?.(sourcePanelId, plot);
            if (plot.cursors?.enabled) this._syncCursorDisplay(sourcePanelId, plot);
            return;
        }
        if (plot.mode === 'heatmap') {
            this._updateHeatmapSelectionShapes?.(sourcePanelId, plot);
            if (plot?.cursors?.enabled) this._renderCursorOverlay(plot);
            // The Heatmap time pane is intentionally local to its analysis;
            // neither it nor the calendar matrix participates in axis sync.
            return;
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
    if (!plot?.div) return;
    const update = this._xAxisUpdateFromRelayout(eventData, plot);
    const range = Array.isArray(update?.['xaxis.range'])
        ? update['xaxis.range']
        : plot.div._fullLayout?.xaxis?.range;

    if (plot._cursorBoxZoomActive) return;

    if (!plot._relayoutLiveOnly && (plot.mode === 'timeseries' || plot.mode === 'fft') && Array.isArray(range) && range.length >= 2) {
        const touchesYAxis = this._relayoutEventTouchesYAxis(eventData);
        if (!touchesYAxis && this._canLiveRefreshTimeseriesRelayout(plot, range)) {
            this._scheduleLiveRelayoutingRefresh(sourcePanelId, plot, range);
        } else {
            this._scheduleRelayoutingRefresh(sourcePanelId, plot, range);
        }
    }

    if (!this._plotSupportsCursors(plot) || !plot.cursors?.enabled) return;
    if (!plot._relayoutLiveOnly && this._relayoutEventTouchesYAxis(eventData)) {
        return;
    }
    if (!Array.isArray(range) || range.length < 2) return;
    this._renderCursorOverlay(plot, { range, lightweight: true });
};

proto._scheduleRelayoutingRefresh = function(panelId, plot, range) {
    if (!plot?.div || !Array.isArray(range) || range.length < 2) return;
    if (plot._cursorBoxZoomActive) return;
    this._clearLiveRelayoutingRefresh(plot);
    plot._relayoutingRefreshRange = [range[0], range[1]];
    if (plot._relayoutingRefreshTimer) clearTimeout(plot._relayoutingRefreshTimer);
    plot._relayoutingRefreshTimer = setTimeout(() => {
        plot._relayoutingRefreshTimer = 0;
        const latestRange = plot._relayoutingRefreshRange;
        plot._relayoutingRefreshRange = null;
        if (!latestRange || plot._relayoutLiveOnly || plot._cursorBoxZoomActive || this.plots.get(panelId) !== plot || !plot.div) return;
        this._onRelayout(panelId, { 'xaxis.range': latestRange });
    }, 140);
};

proto._clearRelayoutingRefresh = function(plot) {
    if (!plot) return;
    if (plot._relayoutingRefreshTimer) clearTimeout(plot._relayoutingRefreshTimer);
    plot._relayoutingRefreshTimer = 0;
    plot._relayoutingRefreshRange = null;
    this._clearLiveRelayoutingRefresh(plot);
};

proto._scheduleLiveRelayoutingRefresh = function(panelId, plot, range, options = {}) {
    if (!plot?.div || !Array.isArray(range) || range.length < 2) return;
    if (plot._relayoutingRefreshTimer) clearTimeout(plot._relayoutingRefreshTimer);
    plot._relayoutingRefreshTimer = 0;
    plot._relayoutingRefreshRange = null;
    plot._liveRelayoutingRefreshRange = [range[0], range[1]];
    if (plot._liveRelayoutingRefreshFrame) return;

    const scheduleFrame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
    plot._liveRelayoutingRefreshFrame = scheduleFrame(() => {
        plot._liveRelayoutingRefreshFrame = 0;
        const latestRange = plot._liveRelayoutingRefreshRange;
        plot._liveRelayoutingRefreshRange = null;
        if (!latestRange || plot._cursorBoxZoomActive || (!options.allowRelayoutLiveOnly && plot._relayoutLiveOnly) || this.plots.get(panelId) !== plot || !plot.div) return;
        if (!this._canLiveRefreshTimeseriesRelayout(plot, latestRange)) {
            this._scheduleRelayoutingRefresh(panelId, plot, latestRange);
            return;
        }
        this._refreshTimeseriesVisuals(panelId, plot, latestRange);
    });
};

proto._clearLiveRelayoutingRefresh = function(plot) {
    if (!plot) return;
    const frame = plot._liveRelayoutingRefreshFrame;
    if (frame) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        else clearTimeout(frame);
    }
    plot._liveRelayoutingRefreshFrame = 0;
    plot._liveRelayoutingRefreshRange = null;
};

// Live pane re-fit during a wheel / right-button drag pan (analysis modes).
// Reuses the same per-mode visual refresh the settle path runs via _onRelayout,
// coalesced to one animation frame so a fast drag does not pile up work. The
// Pan/zoom refresh setting is read at drag time (not captured at chart
// creation), so changing it applies immediately without re-entering the mode.
proto._scheduleLivePanRefresh = function(panelId, plot, range) {
    if (!plot?.div || !Array.isArray(range) || range.length < 2) return;
    plot._livePanRange = [range[0], range[1]];
    if (plot._livePanFrame) return;
    const scheduleFrame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
    plot._livePanFrame = scheduleFrame(() => {
        plot._livePanFrame = 0;
        const latest = plot._livePanRange;
        plot._livePanRange = null;
        if (!latest || this.plots.get(panelId) !== plot || !plot.div) return;
        this._refreshTimeseriesVisuals(panelId, plot, latest);
    });
};

proto._clearLivePanRefresh = function(plot) {
    if (!plot?._livePanFrame) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(plot._livePanFrame);
    else clearTimeout(plot._livePanFrame);
    plot._livePanFrame = 0;
    plot._livePanRange = null;
};

proto._liveRelayoutSuppressed = function(plot) {
    const until = Number(plot?._suppressLiveRelayoutUntil);
    if (!Number.isFinite(until)) return false;
    const now = globalThis.performance?.now?.() ?? Date.now();
    return now < until;
};

proto._suppressLiveRelayout = function(plot, ms = 240) {
    if (!plot) return;
    const now = globalThis.performance?.now?.() ?? Date.now();
    plot._suppressLiveRelayoutUntil = Math.max(Number(plot._suppressLiveRelayoutUntil) || 0, now + ms);
    this._clearLiveRelayoutingRefresh(plot);
};

proto._canLiveRefreshTimeseriesRelayout = function(plot, range) {
    if (!plot?.div || (plot.mode !== 'timeseries' && plot.mode !== 'fft')) return false;
    if (!Array.isArray(range) || range.length < 2) return false;
    if (!Array.isArray(plot.traces) || plot.traces.length === 0) return false;
    if (plot._cursorBoxZoomActive) return false;
    const refreshMode = this.relayoutRefreshMode || 'auto';
    if (refreshMode === 'smooth') return false;
    if (this._liveRelayoutSuppressed(plot)) return false;
    if (plot.traces.some(t => this.files.get(t.fileId)?.data?._duckdb)) return false;

    const fullLimit = PlotManager.LIVE_RELAYOUT_MAX_SOURCE_POINTS || 1250000;
    const viewLimit = PlotManager.LIVE_RELAYOUT_MAX_VIEW_POINTS || 250000;
    const [raw0, raw1] = range.map(value => this._coerceAxisValue?.(value) ?? Number(value));
    const minX = Math.min(raw0, raw1);
    const maxX = Math.max(raw0, raw1);
    const hasNumericRange = Number.isFinite(minX) && Number.isFinite(maxX);

    let totalSourcePoints = 0;
    let totalVisiblePoints = 0;
    for (const trace of plot.traces) {
        const fileData = this.files.get(trace.fileId)?.data;
        const variable = fileData?.variables?.[trace.varName];
        if (!variable) return false;
        if (variable.kind === 'parameter') continue;

        const timeData = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        const values = this._getTransformedVariableData(trace.fileId, trace.varName);
        const sourceLength = Math.min(timeData?.length || 0, values?.length || 0);
        if (refreshMode === 'responsive') continue;
        totalSourcePoints += sourceLength;
        if (totalSourcePoints <= fullLimit) continue;

        if (!hasNumericRange || !timeData?.length) return false;
        const start = Math.max(0, this._lowerBound(timeData, minX) - 1);
        const end = Math.min(sourceLength, this._upperBound(timeData, maxX) + 1);
        totalVisiblePoints += Math.max(0, end - start);
        if (totalVisiblePoints > viewLimit) return false;
    }
    return refreshMode === 'responsive' || totalSourcePoints <= fullLimit || totalVisiblePoints <= viewLimit;
};

proto._relayoutEventTouchesYAxis = function(eventData) {
    if (!eventData) return false;
    return eventData['yaxis.range'] !== undefined
        || eventData['yaxis.range[0]'] !== undefined
        || eventData['yaxis.range[1]'] !== undefined
        || eventData['yaxis.autorange'] !== undefined
        || eventData['yaxis2.range'] !== undefined
        || eventData['yaxis2.range[0]'] !== undefined
        || eventData['yaxis2.range[1]'] !== undefined
        || eventData['yaxis2.autorange'] !== undefined;
};

proto._xAxisUpdateFromRelayout = function(eventData, plot = null) {
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

    const touchedXAxis = eventData['xaxis.autorange'] === false
        || eventData['xaxis.range'] !== undefined
        || r0 !== undefined
        || r1 !== undefined;
    const currentRange = plot?.div?._fullLayout?.xaxis?.range;
    if (touchedXAxis && Array.isArray(currentRange) && currentRange.length >= 2) {
        return { 'xaxis.range': [currentRange[0], currentRange[1]] };
    }

    return null;
};

proto._refreshTimeseriesVisuals = function(panelId, plot = this.plots.get(panelId), visibleRange = null) {
    if (!plot?.div || !['timeseries', 'fft', 'histogram', 'heatmap', 'temporal-profile'].includes(plot.mode)) return;
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
    // Line breaks across missing data must be re-applied here: this restyle is
    // the authoritative data path (runs after create and on every zoom), so it
    // would otherwise overwrite the breaks. The FFT pane always breaks across
    // sampling gaps; timeseries mode does so only under the opt-in flag, where
    // each trace also breaks across its own NaN runs.
    const showMissing = plot.mode === 'timeseries' && plot.showMissingData;
    const fftMode = plot.mode === 'fft';
    const missInfo = showMissing ? this._missingDataInfo(plot) : null;
    // When the view is too dense to resolve gaps, per-gap line breaks would
    // shred the downsampled trace into invisible fragments — skip them (and the
    // bands) and let the "zoom in" pill carry the message, keeping the signal
    // envelope intact. Bands/breaks return in step once the user zooms in.
    const missDense = showMissing ? this._missingViewIsDense(plot, missInfo.bandItems) : false;
    const fftGapInfo = fftMode ? this._fftGapInfo(plot) : null;
    const fftGapsByFile = fftGapInfo ? new Map(fftGapInfo.perFile.map(f => [f.fileId, f])) : null;
    const attachSourceX = showMissing || fftMode;
    plot.traces.forEach((t, idx) => {
        const built = this._buildTimeTrace(t, range, plot, idx, attachSourceX ? { attachSourceX: true } : {});
        if (!built) return;
        if (showMissing && !missDense) this._applyLineBreaks(built, missInfo.traceIntervals.get(this._missTraceKey(t)));
        else if (fftMode) this._applyLineBreaks(built, fftGapsByFile.get(t.fileId)?.gaps);
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
    // Keep the bands' adaptive width in step with the zoom. A shapes-only
    // relayout is ignored by _onRelayout (no x-axis change), so this cannot loop.
    // _missingDataBandShapes sets plot._missingTooDense for the current view;
    // surface the "zoom in" hint accordingly.
    if (showMissing && plot.div) {
        Plotly.relayout(plot.div, { shapes: this._missingDataBandShapes(plot) });
        this._setMissingDensityNotice(plot, missDense);
    }
    this._refreshElapsedDateTimeAxisTicks(plot, range);
};

proto._refreshTimeseriesVisualsLazy = function(panelId, plot, range) {
    if (!this._zoomTokens) this._zoomTokens = new Map();
    const token = (this._zoomTokens.get(panelId) || 0) + 1;
    this._zoomTokens.set(panelId, token);
    this._cancelPendingLazyDetail(panelId);
    const cancelActivePromise = this._cancelActiveLazySources(panelId);

    const targetInfo = this._lazyTimeseriesTarget();
    const target = targetInfo.limit;
    const [t0, t1] = range.map(v => this._coerceAxisValue(v));
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return Promise.resolve();
    // Truthful Missing/NaN bands for the visible range (opt-in; its own async
    // DuckDB query, token-guarded, independent of the trace-data queries).
    this._refreshLazyMissingBands(panelId, plot, t0, t1, token);
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
            const built = this._buildTimeTrace(t, range, plot, idx);
            if (built) immediateResults.push({ idx, x: built.x, y: built.y, customdata: built.customdata, prepared: true });
            if (perf) perf.eagerTraces++;
            return;
        }
        if (perf) perf.lazyTraces++;
        const timeVar = this._getTimeVar(t.fileId);
        const sourceViewportRange = this._sourceRangeForDisplayRange(t.fileId, [t0, t1], timeVar);
        if (!sourceViewportRange || !sourceViewportRange.every(Number.isFinite)) {
            const built = this._buildTimeTrace(t, range, plot, idx);
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
                const built = this._buildTimeTrace(t, range, plot, idx);
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
        await cancelActivePromise;
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
    const cancelActivePromise = this._cancelActiveLazySources(panelId);
    this._setLazyDetailLoading(plot, true, targetInfo, 'phase');
    this._rememberActiveLazySources(panelId, lazyItems.map(item => item.source));

    const settled = this._scheduleLazyDetail(panelId, async () => {
        await cancelActivePromise;
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

    // Map a phaseTraces index to the REAL div trace index. Adding a pair appends
    // its data trace with Plotly.addTraces AFTER the __origin__ cross and the
    // __hover__ markers, so the phaseTraces index no longer equals the div index
    // — restyling by the raw index would land on the origin (its cross marker
    // then draws the pair's points as black crosses with no legend entry).
    const dataTraceIndices = [];
    (plot.div.data || []).forEach((tr, i) => {
        if (tr && tr.name !== '__origin__' && tr.name !== '__hover__') dataTraceIndices.push(i);
    });

    const isPhase2d = plot.mode === 'phase2d';
    const phase2dShowsMarkers = isPhase2d
        ? this._phase2dShowsMarkers(this._ensurePhase2dState(plot))
        : false;
    const xs = [];
    const ys = [];
    const zs = [];
    const types = [];
    const customdata = [];
    let anyCustomdata = false;
    const indices = [];
    for (const result of valid) {
        const divIdx = dataTraceIndices[result.idx];
        if (divIdx === undefined) continue;
        const { pt, visual } = result;
        if (plot.mode === 'phase2dt') {
            const timeVar = this._getTimeVar(pt.fileId);
            xs.push(this._plotlyTimeArray(pt.fileId, visual.time, timeVar));
            ys.push(visual.x);
            zs.push(visual.y);
            const timeCustomdata = this._phase2DtHighResolutionTimeCustomData(plot, pt, visual.time);
            customdata.push(timeCustomdata);
            if (timeCustomdata) anyCustomdata = true;
        } else if (plot.mode === 'phase3d') {
            xs.push(visual.x);
            ys.push(visual.y);
            zs.push(visual.z);
        } else {
            xs.push(visual.x);
            ys.push(visual.y);
        }
        if (isPhase2d) {
            // The trace was built while its lazy data was still empty, so it is a
            // plain SVG 'scatter'; switch large fetched data to WebGL or panning
            // crawls. Marker displays cross to WebGL earlier (SVG makes one DOM
            // node per point).
            const n = visual.x?.length || 0;
            types.push(this._phase2dUseGL(n, phase2dShowsMarkers) ? 'scattergl' : 'scatter');
        }
        indices.push(divIdx);
    }
    if (!indices.length) return Promise.resolve();
    const update = { x: xs, y: ys };
    if (plot.mode === 'phase2dt' || plot.mode === 'phase3d') update.z = zs;
    if (plot.mode === 'phase2dt' && anyCustomdata) update.customdata = customdata;
    if (isPhase2d) update.type = types;
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
        if (plot.mode === 'phase2dt') {
            Object.assign(update, this._timeAxisRelayoutUpdate(layout.scene.xaxis, 'scene.xaxis'));
        }
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
    if (!active?.size) return Promise.resolve(false);
    this._lazyActiveSources.delete(panelId);
    return Promise.allSettled([...active].map(source => {
        if (typeof source?.cancelActiveQuery !== 'function') return false;
        return Promise.resolve(source.cancelActiveQuery()).catch(() => null);
    }));
};

proto._cleanupLazyDetailForPanel = function(panelId, plot = this.plots?.get(panelId)) {
    this._clearRelayoutingRefresh(plot);
    this._cancelPendingLazyDetail(panelId);
    this._cancelActiveLazySources(panelId);
    this._cancelLazyMissingRequest(panelId);
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

// Missing/NaN scans are viewport work too, but they are deliberately tracked
// separately from trace-detail queries. A fast pan can otherwise enqueue one
// full-file CSV scan per relayout; token guards prevent stale paint, but do not
// remove those scans from DuckDB's serialized connection queue.
proto._cancelLazyMissingRequest = function(panelId) {
    const request = this._lazyMissingRequests?.get(panelId);
    if (!request) return false;
    this._lazyMissingRequests.delete(panelId);
    request.controller?.abort?.();
    return true;
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
    if (visual && this.isVariableSignInverted?.(trace.fileId, trace.varName)) {
        visual.y = ArrayBuffer.isView(visual.y)
            ? visual.y.map(value => Number.isFinite(value) ? -value : value)
            : visual.y.map(value => Number.isFinite(value) ? -value : value);
    }
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
    // Cut the min/max envelope across real time gaps (empty buckets) so it never
    // draws a diagonal across a hole — same intent as the eager line breaks.
    // FFT pane: always; timeseries: only under the Missing/NaN opt-in.
    const breakGaps = plot.mode === 'fft' || (plot.mode === 'timeseries' && plot.showMissingData);
    for (const result of valid) {
        const trace = result.trace || plot.traces[result.idx];
        const prepared = result.prepared
            ? { x: result.x, y: result.y, customdata: result.customdata }
            : this._prepareLazyTimeseriesRestyle(trace, result.x, result.y, plot, breakGaps);
        xs.push(prepared.x);
        ys.push(prepared.y);
        cds.push(prepared.customdata ?? null);
        if (prepared.customdata) anyCustomdata = true;
    }
    const update = { x: xs, y: ys };
    if (anyCustomdata) update.customdata = cds;
    return Plotly.restyle(plot.div, update, valid.map(result => result.idx));
};

proto._prepareLazyTimeseriesRestyle = function(trace, x, y, plot = null, breakGaps = false) {
    const fileId = trace?.fileId;
    const timeVar = this._getTimeVar(fileId);
    let visualX = Array.from(x || [], (value, index) =>
        this._displayTimeForFetchedSourceTime(fileId, value, index, timeVar)
    );
    let visualY = y;
    if (plot?.timeseriesStacked) {
        const padded = this._applyTimeseriesStackZeroPadding(plot, trace, { x: visualX, y });
        visualX = padded.x;
        visualY = padded.y;
    }
    // Detect gap-break positions on the numeric display time BEFORE the Plotly
    // conversion (which may return Date objects / strings that don't subtract).
    const breaks = breakGaps ? this._lazyGapBreakIndices(visualX) : null;
    const plotX = this._plotlyTimeArray(fileId, visualX, timeVar);
    const generatedCalendarAxis = this._isGeneratedCalendarTime(fileId, timeVar);
    const durationAxis = this._timeDisplayModeForVar(fileId, timeVar) === 'elapsedDateTime'
        || (this._isGeneratedDurationTime(fileId, timeVar) && !generatedCalendarAxis);
    const customdata = generatedCalendarAxis
        ? visualX.map(value => this._formatGeneratedCalendarDateTime(fileId, value, timeVar))
        : durationAxis
        ? visualX.map(value => this._formatElapsedDateTime(value, this._durationFractionDigits(fileId)))
        : undefined;
    if (breaks && breaks.length) return this._insertTraceGapBreaks(plotX, visualY, customdata, breaks);
    return { x: plotX, y: visualY, customdata };
};

// Indices i (0-based) after which a min/max-envelope trace jumps across a real
// time gap: the visible range is bucketed uniformly (~2 points per bucket), so a
// normal step is at most one bucket width; anything well beyond that is a hole.
proto._lazyGapBreakIndices = function(visualX) {
    const n = visualX?.length || 0;
    if (n < 4) return [];
    const span = visualX[n - 1] - visualX[0];
    if (!(span > 0)) return [];
    const threshold = (span / (n / 2)) * 1.5; // 1.5 × bucket width
    const idx = [];
    for (let i = 1; i < n; i++) {
        if (visualX[i] - visualX[i - 1] > threshold) idx.push(i - 1);
    }
    return idx;
};

// Insert a NaN point after each break index so Plotly cuts the connecting
// segment (mirrors _applyLineBreaks for the eager path).
proto._insertTraceGapBreaks = function(plotX, y, customdata, breakIdx) {
    const breakSet = new Set(breakIdx);
    const n = Math.min(plotX.length, y.length);
    const outX = [];
    const outY = [];
    const outCd = customdata ? [] : undefined;
    for (let i = 0; i < n; i++) {
        outX.push(plotX[i]);
        outY.push(y[i]);
        if (outCd) outCd.push(customdata[i]);
        if (breakSet.has(i)) {
            outX.push(plotX[i]);
            outY.push(NaN);
            if (outCd) outCd.push(null);
        }
    }
    return { x: outX, y: outY, customdata: outCd };
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
    // This indicator has a dedicated class: Missing/NaN and analysis modes use
    // the same visual component but own independent lifecycles. A generic
    // `.lazy-detail-indicator` lookup used to hijack and later remove the
    // "Searching for missing data…" pill while its query was still running.
    let indicator = panelEl.querySelector('.lazy-data-detail-indicator');
    if (loading && panelEl.querySelector('.missing-dense-indicator')) {
        indicator?.remove();
        return;
    }
    if (loading && !indicator) {
        indicator = document.createElement('div');
        indicator.className = 'lazy-detail-indicator lazy-data-detail-indicator';
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

// Non-blocking "missing data too dense — zoom in" hint over the timeseries
// plot, shown when _adaptiveGapBandShapes flagged plot._missingTooDense for the
// current view. Reuses the lazy-detail pill styling (pointer-events:none) but
// without a spinner. Toggled from the authoritative restyle path so it tracks
// zoom, and cleared when the Missing/NaN overlay is turned off.
// `state`: false/null → hide; true/'dense' → "too dense, zoom in"; 'loading' →
// a spinner + "Searching for missing data…" while the lazy DuckDB query runs
// (so the user knows something is happening before the bands appear).
proto._setMissingDensityNotice = function(plot, state) {
    const panelEl = plot?.div?.closest('.layout-panel');
    if (!panelEl) return;
    const mode = state === true ? 'dense' : (state || null);
    let pill = panelEl.querySelector('.missing-dense-indicator');
    if (mode === 'dense' || mode === 'loading') {
        if (!pill) {
            pill = document.createElement('div');
            pill.className = 'lazy-detail-indicator missing-dense-indicator';
            pill.setAttribute('aria-live', 'polite');
            pill.innerHTML = '<span class="lazy-detail-spinner missing-notice-spinner" aria-hidden="true"></span><span class="lazy-detail-text"></span>';
            panelEl.appendChild(pill);
        }
        const label = i18n.t(mode === 'loading' ? 'timeseriesMissingSearching' : 'timeseriesMissingDense');
        const text = pill.querySelector('.lazy-detail-text');
        if (text) text.textContent = label;
        const spinner = pill.querySelector('.missing-notice-spinner');
        if (spinner) spinner.style.display = mode === 'loading' ? '' : 'none';
        pill.title = label;
        pill.setAttribute('aria-label', label);
        pill.classList.add('active');
    } else if (pill) {
        pill.classList.remove('active');
        pill.remove();
    }
};

// Truthful Missing/NaN bands for a LAZY (DuckDB) timeseries view. The eager
// _refreshTimeseriesVisuals path never runs for a lazy panel (it returns early
// to _refreshTimeseriesVisualsLazy), and the in-memory overview is a reservoir
// sample that can't reveal real gaps — so query DuckDB for per-pixel-bucket
// missing counts over the visible range, reduce to coalesced intervals, and
// render exactly like eager (bands + faint wash + "zoom in" pill). Eager files
// sharing the panel keep their sync detection (they are view-mode-gated out of
// the query but flow through _missingDataInfo here).
proto._refreshLazyMissingBands = function(panelId, plot, t0, t1, token) {
    // Timeseries: opt-in via the Missing/NaN button. FFT time pane: always on
    // (the bands tell the user which spans are clean enough to select for the
    // FFT). Other modes: nothing.
    const active = plot?.div
        && (plot.mode === 'fft' || (plot.mode === 'timeseries' && plot.showMissingData));
    if (!active) {
        this._cancelLazyMissingRequest(panelId);
        return Promise.resolve([]);
    }

    // Latest viewport wins. Aborting here cancels an executing scan and also
    // marks queued scans so DuckDbSource drops them before they reach DuckDB.
    this._cancelLazyMissingRequest(panelId);

    const perFile = new Map();
    for (const t of plot.traces) {
        if (!this._isVisible(t)) continue;
        const data = this.files.get(t.fileId)?.data;
        const source = data?._duckdb?.source;
        if (!source?.getMissingIntervals || !data._duckdb.viewMode) continue;
        let entry = perFile.get(t.fileId);
        if (!entry) {
            entry = { data, source, timeVar: this._getTimeVar(t.fileId), varNames: new Set() };
            perFile.set(t.fileId, entry);
        }
        entry.varNames.add(t.varName);
    }
    const eagerItems = this._missingDataInfo(plot).bandItems; // non-view files only

    // Cache the verdict, then paint. Timeseries paints the bands directly and
    // shows the "zoom in" pill; the FFT time pane re-derives its shapes via
    // _fftTimePaneShapes (so the selection rectangle survives) and skips the pill.
    const render = (allItems, solidItems, dense) => {
        if (!plot.div) return;
        plot._lazyMissItems = allItems;
        plot._lazyMissSolid = solidItems;
        plot._lazyMissDense = dense;
        if (plot.mode === 'fft') {
            this._setMissingDensityNotice(plot, false); // no pill on the FFT pane
            Plotly.relayout(plot.div, { shapes: this._fftTimePaneShapes(plot) });
            return;
        }
        if (!plot.showMissingData) return;
        Plotly.relayout(plot.div, { shapes: this._lazyMissingShapes(plot) });
        this._setMissingDensityNotice(plot, dense);
    };

    if (!perFile.size) {
        render(eagerItems, [], this._missingViewIsDense(plot, eagerItems));
        return Promise.resolve([]);
    }

    const xa = plot.div._fullLayout?.xaxis;
    const pxWidth = Math.max(50, Math.min(2000, Math.round(xa?._length || 1500)));
    const sig = [
        pxWidth, Math.round(t0), Math.round(t1), eagerItems.length,
        [...perFile.entries()].map(([fid, e]) => `${fid}:${[...e.varNames].sort().join(',')}`).join('|'),
    ].join('');
    if (plot._lazyMissSig === sig && plot._lazyMissItems) {
        render(plot._lazyMissItems, plot._lazyMissSolid || [], plot._lazyMissDense);
        return Promise.resolve(plot._lazyMissItems);
    }

    // Immediate feedback: a spinner pill while the query runs.
    if (plot.mode === 'timeseries') this._setMissingDensityNotice(plot, 'loading');

    const controller = new AbortController();
    const request = { controller, token, plot };
    if (!this._lazyMissingRequests) this._lazyMissingRequests = new Map();
    this._lazyMissingRequests.set(panelId, request);

    const settled = Promise.all([...perFile.entries()].map(([fileId, entry]) => {
        const src = this._sourceRangeForDisplayRange(fileId, [t0, t1], entry.timeVar);
        if (!src || !src.every(Number.isFinite)) return { intervals: [], solidIntervals: [], dense: false };
        const sourceLo = Math.min(src[0], src[1]);
        const sourceHi = Math.max(src[0], src[1]);
        if (!(sourceHi > sourceLo)) return { intervals: [], solidIntervals: [], dense: false };
        // Cap buckets to the estimated sample count where a cheap row estimate
        // exists (notably Parquet). Raw CSV views deliberately skip COUNT at
        // load time; their timestamp bounds make oversampled buckets safe.
        const nBuckets = this._lazyMissingBucketCount(entry.data, sourceLo, sourceHi, pxWidth);
        return entry.source.getMissingIntervals(
            entry.data,
            [...entry.varNames],
            sourceLo,
            sourceHi,
            nBuckets,
            { signal: controller.signal },
        ).then(({ buckets }) => missingBucketsToIntervals(buckets, {
            t0: sourceLo,
            t1: sourceHi,
            nBuckets,
            fileId,
            timeVar: entry.timeVar,
            // The FFT time pane and the trace data both use this canonical
            // conversion. Keeping bands on it prevents source/display drift.
            mapTime: value => this._displayTimeForFetchedSourceTime(fileId, value, null, entry.timeVar),
        })).catch(err => {
            if (err?.name === 'AbortError') throw err;
            console.warn('[missing] lazy query failed:', err);
            return { intervals: [], solidIntervals: [], dense: false };
        });
    })).then(perFileResults => {
        const stillActive = plot.mode === 'fft'
            || (plot.mode === 'timeseries' && plot.showMissingData);
        if (this._lazyMissingRequests?.get(panelId) !== request
            || this._zoomTokens?.get(panelId) !== token
            || !plot.div
            || !stillActive) return [];
        const lazyItems = [];
        const solidItems = [];
        let lazyDense = false;
        for (const r of perFileResults) {
            lazyItems.push(...(r.intervals || []));
            solidItems.push(...(r.solidIntervals || []));
            if (r.dense) lazyDense = true;
        }
        const items = [...eagerItems, ...lazyItems];
        const dense = lazyDense || this._missingViewIsDense(plot, eagerItems);
        plot._lazyMissSig = sig;
        render(items, solidItems, dense); // caches items/solid/dense on the plot
        return items;
    }).catch(err => {
        if (err?.name !== 'AbortError') console.warn('[missing] lazy refresh failed:', err);
        if (this._lazyMissingRequests?.get(panelId) === request
            && this._zoomTokens?.get(panelId) === token
            && plot.mode === 'timeseries') {
            this._setMissingDensityNotice(plot, false);
        }
        return [];
    }).finally(() => {
        if (this._lazyMissingRequests?.get(panelId) === request) {
            this._lazyMissingRequests.delete(panelId);
        }
    });
    request.promise = settled;
    this._lastLazyMissingRefresh = settled;
    return settled;
};

// Shapes for the cached lazy Missing/NaN verdict: the wash (any-missing,
// dense-aware, wall-suppressed) with fully-missing gaps/blocks always on top.
proto._lazyMissingShapes = function(plot) {
    const items = plot?._lazyMissItems || [];
    const solid = plot?._lazyMissSolid || [];
    if (!items.length && !solid.length) return [];
    const dense = !!plot._lazyMissDense;
    const wash = this._adaptiveGapBandShapes(plot, items, dense);
    const solidShapes = dense ? this._adaptiveGapBandShapes(plot, solid, false) : [];
    return [...wash, ...solidShapes];
};

// Buckets for the lazy Missing/NaN query: ~one per on-screen pixel, but never
// more than the estimated number of samples in view (uniform-rate estimate from
// totalRows over the data's time extent) — otherwise sub-sampling buckets sit
// empty and get read as time gaps.
proto._lazyMissingBucketCount = function(data, sourceLo, sourceHi, pxWidth) {
    const meta = data?._duckdb;
    const totalRows = Number(meta?.totalRows);
    const dataStart = Number(data?.metadata?.timeStart);
    const dataEnd = Number(data?.metadata?.timeEnd);
    let estimate = pxWidth;
    if (Number.isFinite(totalRows) && totalRows > 0
        && Number.isFinite(dataStart) && Number.isFinite(dataEnd) && dataEnd > dataStart) {
        const lo = Math.min(sourceLo, sourceHi);
        const hi = Math.max(sourceLo, sourceHi);
        const overlap = Math.max(0, Math.min(hi, dataEnd) - Math.max(lo, dataStart));
        estimate = totalRows * (overlap / (dataEnd - dataStart));
    }
    return Math.max(1, Math.min(pxWidth, Math.ceil(estimate)));
};

proto._refreshElapsedDateTimeAxisTicks = function(plot, range = null) {
    if (!plot?.div || !['timeseries', 'fft', 'histogram', 'heatmap', 'temporal-profile'].includes(plot.mode)) {
        return Promise.resolve();
    }
    const fid = this._primaryTimeFileId(plot);
    const timeVar = this._getTimeVar(fid);
    const generatedCalendarAxis = this._isGeneratedCalendarTime(fid, timeVar);
    if (generatedCalendarAxis) {
        const values = Array.isArray(range) && range.length >= 2
            ? range.map(value => {
                const numeric = Number(value);
                return Number.isFinite(numeric) ? numeric : NaN;
            })
            : plot.traces.map(t => this._getTransformedTimeDataForVariable(t.fileId, t.varName));
        const config = this._calendarAxisConfig(fid, timeVar, values);
        if (!config.tickvals || !config.ticktext) return Promise.resolve();
        return Plotly.relayout(plot.div, {
            'xaxis.tickmode': config.tickmode,
            'xaxis.tickvals': config.tickvals,
            'xaxis.ticktext': config.ticktext,
        });
    }
    if (this._timeDisplayModeForVar(fid, timeVar) !== 'elapsedDateTime' && !this._isGeneratedDurationTime(fid, timeVar)) {
        return Promise.resolve();
    }
    const values = Array.isArray(range) && range.length >= 2
        ? range.map(value => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : NaN;
        })
        : plot.traces.map(t => this._getTransformedTimeDataForVariable(t.fileId, t.varName));
    const config = this._elapsedDateTimeAxisConfig(values, fid);
    if (!config.tickvals || !config.ticktext) return Promise.resolve();
    return Plotly.relayout(plot.div, {
        'xaxis.tickmode': config.tickmode,
        'xaxis.tickvals': config.tickvals,
        'xaxis.ticktext': config.ticktext,
    });
};

proto._refreshAllTimeseriesVisuals = function() {
    for (const [panelId, plot] of this.plots) {
        if (plot?.div && ['timeseries', 'fft', 'histogram', 'heatmap', 'temporal-profile'].includes(plot.mode)) {
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
                    const tdata = this._getTransformedTimeDataForVariable(t.fileId, t.varName);
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
                                axis: this._traceYAxis(t, plot),
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
                        const tdata = this._getTransformedTimeDataForVariable(pt2.fileId, pt2.x);
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
                        const tdata = this._getTransformedTimeDataForVariable(pt2.fileId, pt2.x);
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
                        const tdata = this._getTransformedTimeDataForVariable(pt2.fileId, pt2.x);
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
                        const tdata = this._getTransformedTimeDataForVariable(pt2.fileId, pt2.x);
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
                        const tdata = this._getTransformedTimeDataForVariable(pt2.fileId, pt2.x);
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
                        const tdata = this._getTransformedTimeDataForVariable(pt2.fileId, pt2.x);
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
                    const tidx = this._findTimeIdx(this._getTransformedTimeDataForVariable(
                        plot.stateSlots.fileId,
                        plot.stateSlots.x?.[0],
                    ), xVal);
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

proto._hoverOverlayGeometry = function(plot, x, y = null, axis = 'y') {
    if (!plot?.div) return null;
    const xValue = this._coerceAxisValue(x);
    if (!Number.isFinite(xValue)) return null;
    const fl = plot.div._fullLayout;
    const xa = fl?.xaxis;
    const ya = axis === 'y2' && fl?.yaxis2 ? fl.yaxis2 : fl?.yaxis;
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
        const g = this._hoverOverlayGeometry(plot, marker.x, marker.y, marker.axis || 'y');
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

// ---- Cursor views ---------------------------------------------------------
// The measurement-cursor machinery runs per "view": a small descriptor that
// names which plotly div and which cursor-state object to operate on. The
// timeseries mode has one view ('main'). The FFT mode has two: 'main' (the
// FFT time pane — plot.div, identical semantics to timeseries) and
// 'spectrum' (plot.fftDiv, fed by the computed spectra; x is frequency,
// 1/Δx is a period, and the secant/slope have no meaning there).

proto._plotSupportsCursors = function(plot) {
    return plot?.mode === 'timeseries' || plot?.mode === 'fft'
        || plot?.mode === 'histogram' || plot?.mode === 'heatmap' || plot?.mode === 'temporal-profile';
};

// True while ANY cursor window is open. FFT has two (time + spectrum); the A|B
// button reflects this, so it reads "on" until both are closed, and one press
// then closes whatever remains before the next press reopens both.
proto._anyCursorEnabled = function(plot) {
    if (!plot) return false;
    if (plot.cursors?.enabled) return true;
    return plot.mode === 'fft' && !!plot.cursorsSpectrum?.enabled;
};

proto._cursorViews = function(panelId, plot) {
    if (!plot?.div || !this._plotSupportsCursors(plot)) return [];
    const main = { id: 'main', panelId, plot, isSpectrum: false };
    if (plot.mode !== 'fft') return [main];
    return plot.fftDiv ? [main, { id: 'spectrum', panelId, plot, isSpectrum: true }] : [main];
};

proto._viewDiv = function(view) {
    return view.isSpectrum ? view.plot.fftDiv : view.plot.div;
};

proto._viewCursors = function(view) {
    const plot = view.plot;
    if (view.isSpectrum) {
        if (!plot.cursorsSpectrum) plot.cursorsSpectrum = this._defaultCursors();
        return plot.cursorsSpectrum;
    }
    if (!plot.cursors) plot.cursors = this._defaultCursors();
    return plot.cursors;
};

// The spectrum series backing a trace: the computed spectrum whose plotly
// name matches the trace (plot._fftSpectra is rebuilt on every recompute).
proto._fftSpectrumSeriesForTrace = function(plot, trace) {
    if (!trace) return null;
    const name = this._traceName(trace.varName, trace.fileId);
    const spectrum = (plot._fftSpectra || []).find(s => s.name === name);
    if (!spectrum?.x?.length || !spectrum?.y?.length) return null;
    return { times: spectrum.x, values: spectrum.y };
};

proto._cursorSeriesForTrace = function(view, trace) {
    if (view.isSpectrum) return this._fftSpectrumSeriesForTrace(view.plot, trace);
    return this._traceInterpolationSeries(view.plot, trace);
};

proto._cursorInterpolationMode = function(view, trace) {
    return view.isSpectrum ? 'linear' : this._traceInterpolationMode(trace);
};

proto._toggleCursors = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot || !plot.div || !this._plotSupportsCursors(plot)) return;
    // Merge with the defaults so cursors restored from older sessions gain
    // any newly added fields.
    plot.cursors = { ...this._defaultCursors(), ...(plot.cursors || {}) };
    plot.cursorsSpectrum = { ...this._defaultCursors(), ...(plot.cursorsSpectrum || {}) };
    // Any open window means the press closes everything first; only from the
    // fully-closed state does a press reopen all views.
    const enabled = !this._anyCursorEnabled(plot);
    for (const view of this._cursorViews(panelId, plot)) {
        this._viewCursors(view).enabled = enabled;
    }
    if (enabled) {
        for (const view of this._cursorViews(panelId, plot)) {
            this._initializeCursorPositionsInView(view);
        }
        this._installCursorHandlers(panelId, plot);
        this._syncCursorDisplay(panelId, plot);
        this._refreshActionBtns(panelId);
    } else {
        document.body.classList.remove('cursor-dragging', 'cursor-box-dragging');
        for (const view of this._cursorViews(panelId, plot)) {
            const div = this._viewDiv(view);
            if (div) div.style.cursor = '';
            this._hideCursorOverlay(view);
        }
        plot.div.closest('.layout-panel')?.classList.remove('cursor-near');
        this._hideCursorBox(plot.div.closest('.layout-panel'));
        this._refreshActionBtns(panelId);
    }
};

// Close a single cursor window (the X on its box). In FFT the other window
// stays open; the A|B button reflects _anyCursorEnabled, so it only switches
// off once every window is closed.
proto._closeCursorView = function(panelId, plot, view) {
    if (!plot || !view) return;
    this._viewCursors(view).enabled = false;
    const div = this._viewDiv(view);
    if (div) div.style.cursor = '';
    this._hideCursorOverlay(view);
    const panelEl = plot.div?.closest('.layout-panel');
    this._hideCursorViewBox(panelEl, view.id);
    // When nothing is left open, drop the shared drag/hover affordances too.
    if (!this._anyCursorEnabled(plot)) {
        document.body.classList.remove('cursor-dragging', 'cursor-box-dragging');
        panelEl?.classList.remove('cursor-near');
    }
    this._refreshActionBtns(panelId);
};

proto._ensureCursorPositions = function(view) {
    this._ensureCursorPosition(view, 'a', 0.25);
    this._ensureCursorPosition(view, 'b', 0.75);
};

proto._initializeCursorPositionsInView = function(view) {
    this._initializeCursorPositionInView(view, 'a', 0.25);
    this._initializeCursorPositionInView(view, 'b', 0.75);
};

proto._cursorTraceBounds = function(view, trace) {
    if (!trace) return null;
    let times;
    if (view.isSpectrum) {
        times = this._fftSpectrumSeriesForTrace(view.plot, trace)?.times;
    } else {
        times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
    }
    if (!times?.length) return null;
    const start = Number(times[0]);
    const end = Number(times[times.length - 1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return start <= end ? { start, end } : { start: end, end: start };
};

proto._cursorViewBounds = function(view, trace) {
    const traceBounds = this._cursorTraceBounds(view, trace);
    if (!traceBounds) return null;
    const range = this._viewDiv(view)?._fullLayout?.xaxis?.range;
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

proto._clampCursorX = function(view, which, x) {
    if (!Number.isFinite(x)) return x;
    const trace = this._resolveCursorTrace(view, which);
    const bounds = this._cursorTraceBounds(view, trace);
    if (!bounds) return x;
    return Math.max(bounds.start, Math.min(bounds.end, x));
};

proto._ensureCursorPosition = function(view, which, fraction) {
    const cursors = this._viewCursors(view);
    const trace = this._resolveCursorTrace(view, which);
    const bounds = this._cursorViewBounds(view, trace);
    if (!bounds) return;
    const span = bounds.end - bounds.start;
    const target = bounds.start + (span || 0) * fraction;
    cursors[which] = Number.isFinite(cursors[which])
        ? this._clampCursorX(view, which, cursors[which])
        : this._clampCursorX(view, which, target);
};

proto._initializeCursorPositionInView = function(view, which, fraction) {
    const cursors = this._viewCursors(view);
    const trace = this._resolveCursorTrace(view, which);
    const bounds = this._cursorViewBounds(view, trace);
    if (!bounds) return;
    const span = bounds.end - bounds.start;
    cursors[which] = this._clampCursorX(view, which, bounds.start + (span || 0) * fraction);
};

proto._resolveCursorTrace = function(view, which) {
    const plot = view.plot;
    if (!plot?.traces?.length) return null;
    const cursors = this._viewCursors(view);
    const visibleTraces = plot.traces.filter(t => t.visible !== false && t.visible !== 'legendonly');
    if (!visibleTraces.length) return null;
    const key = which === 'b' ? 'traceB' : 'traceA';
    if (!cursors[key] && cursors.trace) {
        cursors[key] = cursors.trace;
    }
    const preferred = cursors[key];
    if (preferred) {
        const found = visibleTraces.find(t => t.fileId === preferred.fileId && t.varName === preferred.varName);
        if (found) return found;
    }
    const fallback = which === 'b'
        ? (visibleTraces[1] || visibleTraces[0])
        : visibleTraces[0];
    if (fallback) cursors[key] = { fileId: fallback.fileId, varName: fallback.varName };
    return fallback;
};

proto._sameCursorTrace = function(traceA, traceB) {
    return !!(traceA && traceB && traceA.fileId === traceB.fileId && traceA.varName === traceB.varName);
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
    const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
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

proto._jumpCursorTo = async function(view, which, target, direction = 'next') {
    const { panelId, plot } = view;
    const cursors = this._viewCursors(view);
    if (!cursors.enabled) return;
    const trace = this._resolveCursorTrace(view, which);
    if (!trace) return;
    const cursorX = cursors[which];
    if (!Number.isFinite(cursorX)) return;

    if (view.isSpectrum) {
        const series = this._fftSpectrumSeriesForTrace(plot, trace);
        const nextX = this._findCursorTargetInSeries(trace, target, series?.times, series?.values, cursorX, direction);
        if (!Number.isFinite(nextX)) return;
        cursors[which] = nextX;
        this._syncCursorDisplay(panelId, plot);
        return;
    }

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
            cursors[which] = renderedNextX;
            this._syncCursorDisplay(panelId, plot);
            return;
        }

        try {
            const lazyNextX = await this._findLazyCursorTarget(fileData, trace, cursorX, target, direction);
            if (Number.isFinite(lazyNextX)) {
                cursors[which] = lazyNextX;
                this._syncCursorDisplay(panelId, plot);
                return;
            }
        } catch (err) {
            console.warn('[duckdb] cursor jump query failed; falling back to overview:', err?.message || err);
        }
    }

    if (!times) {
        times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        values = this._getTransformedVariableData(trace.fileId, trace.varName);
    }

    let nextX = NaN;
    nextX = this._findCursorTargetInSeries(trace, target, times, values, cursorX, direction);
    if (!Number.isFinite(nextX)) return;
    cursors[which] = nextX;
    this._syncCursorDisplay(panelId, plot);
};

proto._panelGuideShapes = function(plot, extra = []) {
    return extra;
};

proto._syncCursorDisplay = function(panelId, plot, options = {}) {
    if (!plot?.div || !this._plotSupportsCursors(plot)) return;
    const panelEl = plot.div.closest('.layout-panel');
    const timeSeriesHidden = (plot.mode === 'fft' && plot.fft?.timeSeriesHidden === true)
        || (plot.mode === 'histogram' && plot.histogram?.timeSeriesHidden === true)
        || (plot.mode === 'heatmap' && plot.heatmap?.timeSeriesHidden === true)
        || (plot.mode === 'temporal-profile' && plot.temporalProfile?.timeSeriesHidden === true);
    for (const view of this._cursorViews(panelId, plot)) {
        if (timeSeriesHidden && !view.isSpectrum) {
            this._hideCursorOverlay(view);
            this._hideCursorViewBox(panelEl, view.id);
            continue;
        }
        const cursors = this._viewCursors(view);
        if (cursors.enabled) {
            this._ensureCursorPositions(view);
            this._renderCursorViewOverlay(view, options);
        } else {
            this._hideCursorOverlay(view);
        }
        this._updateCursorBox(view);
    }
};

proto._cursorOverlayGeometry = function(view, trace, x, options = {}) {
    const div = this._viewDiv(view);
    if (!div || !trace || !Number.isFinite(x)) return null;
    const fl = div._fullLayout;
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
        const series = this._cursorSeriesForTrace(view, trace);
        y = series
            ? this._interpolateAt(series.times, series.values, x, this._cursorInterpolationMode(view, trace))
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

// Compatibility wrapper: external callers hold a plot; render every view.
proto._renderCursorOverlay = function(plot, options = {}) {
    for (const view of this._cursorViews(null, plot)) {
        if (!this._viewCursors(view).enabled) continue;
        // options.range comes from timeseries relayout events and only makes
        // sense for the main view's x axis.
        this._renderCursorViewOverlay(view, view.isSpectrum ? { lightweight: options.lightweight, force: options.force } : options);
    }
};

proto._renderCursorViewOverlay = function(view, options = {}) {
    const plot = view.plot;
    const div = this._viewDiv(view);
    const cursors = this._viewCursors(view);
    if (!div || !cursors.enabled) return;
    if (plot._cursorBoxZoomActive && !options.force) {
        return;
    }
    let overlay = div.querySelector('.cursor-plot-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'cursor-plot-overlay';
        div.appendChild(overlay);
    }

    const traceA = this._resolveCursorTrace(view, 'a');
    const traceB = this._resolveCursorTrace(view, 'b');
    const items = [
        { key: 'a', trace: traceA, x: cursors.a, color: traceA?.color || '#ff9800', dash: false },
        { key: 'b', trace: traceB, x: cursors.b, color: traceB?.color || '#2196f3', dash: this._sameCursorTrace(traceA, traceB) },
    ];
    const parts = [];
    const geometries = {};
    for (const item of items) {
        const g = this._cursorOverlayGeometry(view, item.trace, item.x, options);
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
    if (!options.lightweight && !view.isSpectrum && cursors.showSecant && geometries.a && geometries.b) {
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

proto._hideCursorOverlay = function(view) {
    const overlay = this._viewDiv(view)?.querySelector('.cursor-plot-overlay');
    if (overlay) {
        overlay.style.display = 'none';
        overlay.innerHTML = '';
    }
};

proto._beginCursorBoxZoomSuppress = function(panelId, plot) {
    if (!plot?.div || plot._cursorBoxZoomActive) return;
    plot._cursorBoxZoomActive = true;
    this._suppressLiveRelayout(plot, 2000);
    const release = () => {
        document.removeEventListener('mouseup', release, true);
        document.removeEventListener('keydown', cancel, true);
        window.setTimeout(() => {
            plot._cursorBoxZoomActive = false;
            plot._suppressLiveRelayoutUntil = 0;
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

proto._cursorPairSlideDelta = function(view, startA, startB, delta) {
    if (!Number.isFinite(delta)) return 0;
    let minDelta = -Infinity;
    let maxDelta = Infinity;
    for (const which of ['a', 'b']) {
        const start = which === 'a' ? startA : startB;
        if (!Number.isFinite(start)) continue;
        const trace = this._resolveCursorTrace(view, which);
        const bounds = this._cursorTraceBounds(view, trace);
        if (!bounds) continue;
        minDelta = Math.max(minDelta, bounds.start - start);
        maxDelta = Math.min(maxDelta, bounds.end - start);
    }
    if (minDelta > maxDelta) return 0;
    if (Number.isFinite(minDelta)) delta = Math.max(delta, minDelta);
    if (Number.isFinite(maxDelta)) delta = Math.min(delta, maxDelta);
    return delta;
};

// Two-finger trackpad pan on 2D cartesian plots.
//
// Plotly only maps the wheel to zoom (via deltaY), so a horizontal swipe does
// nothing today. This adds an ADDITIVE gesture: a swipe that STARTS
// horizontally latches into "pan" for the whole gesture — panning by both
// deltaX and deltaY — so "sideways then up" pans in 2D. A gesture that starts
// vertically (or a pinch, ctrlKey) is left untouched so Plotly's zoom keeps
// working exactly as before. 3D scenes are never wired up.
proto._installWheelPan = function(panelId, plot, div, options = {}) {
    if (!div || div._wheelPanBound) return;
    div._wheelPanBound = true;

    // A single idle timer defines the gesture: while it is alive the latched
    // mode never changes. Windows locks the scroll axis per physical touch,
    // so a horizontal-started gesture never delivers deltaY — to pan
    // vertically the user must lift and re-place their fingers, which starts
    // a fresh (Y-locked) gesture. This window keeps the pan latch alive long
    // enough to bridge that lift-and-replace before it reverts to
    // "vertical two-finger = zoom". The OS also fires inertia events, so a
    // plain pan glides to a stop on its own.
    const END_MS = 800;
    // The data refresh (new points at the right resolution for the new
    // window) fires this soon after movement stops — decoupled from the long
    // pan-mode latch, so points do not appear only when the latch expires.
    const SETTLE_MS = 150;
    const state = { mode: null, raf: 0, endTimer: 0, settleTimer: 0, base: null, pendingDX: 0, pendingDY: 0, latestXRange: null };

    const deltaScale = (event) => {
        if (event.deltaMode === 1) return 16;   // lines -> px (Firefox)
        if (event.deltaMode === 2) return div.clientHeight || 800; // pages -> px
        return 1;
    };

    const captureBase = () => {
        const fl = div._fullLayout;
        const xa = fl?.xaxis, ya = fl?.yaxis;
        if (!xa || !ya || !xa._length || !ya._length) return null;
        const xNumeric = xa.range.map(v => this._coerceAxisValue(v));
        const yNumeric = ya.range.map(v => Number(v));
        if (!xNumeric.every(Number.isFinite) || !yNumeric.every(Number.isFinite)) return null;
        const y2a = (plot.timeseriesY2Enabled && plot.mode === 'timeseries') ? fl?.yaxis2 : null;
        const y2Numeric = y2a?.range ? y2a.range.map(v => Number(v)) : null;
        return {
            xLen: xa._length,
            yLen: ya._length,
            xSpan: xNumeric[1] - xNumeric[0],
            ySpan: yNumeric[1] - yNumeric[0],
            curX: xNumeric.slice(),
            curY: yNumeric.slice(),
            isDateX: xa.type === 'date',
            y2Len: y2a?._length || null,
            y2Span: y2Numeric ? y2Numeric[1] - y2Numeric[0] : null,
            curY2: y2Numeric ? y2Numeric.slice() : null,
        };
    };

    const flush = () => {
        state.raf = 0;
        const base = state.base;
        if (!base) return;
        // Browser convention: deltaX>0 scrolls right, deltaY>0 scrolls down.
        // Panning follows the revealed direction (scroll right -> later data,
        // scroll up -> higher values), so the view tracks the fingers.
        const dxPx = state.pendingDX;
        const dyPx = state.pendingDY;
        state.pendingDX = 0;
        state.pendingDY = 0;
        const xShift = (dxPx / base.xLen) * base.xSpan;
        const yShift = -(dyPx / base.yLen) * base.ySpan;
        base.curX = [base.curX[0] + xShift, base.curX[1] + xShift];
        base.curY = [base.curY[0] + yShift, base.curY[1] + yShift];
        state.latestXRange = base.isDateX ? base.curX.map(v => new Date(v).toISOString()) : base.curX.slice();
        const update = {
            'xaxis.range': state.latestXRange,
            'yaxis.range': base.curY.slice(),
        };
        if (base.curY2 && base.y2Len && base.y2Span != null) {
            // The secondary Y pans by the same pixel delta as the primary.
            const y2Shift = -(dyPx / base.y2Len) * base.y2Span;
            base.curY2 = [base.curY2[0] + y2Shift, base.curY2[1] + y2Shift];
            update['yaxis2.range'] = base.curY2.slice();
        }
        plot._relayoutLiveOnly = true;
        // Read the Pan/zoom refresh setting live so it applies immediately in
        // whatever analysis mode owns this pane. Responsive re-fits during the
        // drag; Auto/After-pan defer to the settle finalize below. Only the
        // TIME pane (plot.div) may drive this — panning the results pane
        // (spectrum/histogram) carries a FREQUENCY range that must never be fed
        // to the time pane, or its traces empty out.
        if (div === plot.div && (this.relayoutRefreshMode || 'auto') === 'responsive') {
            this._scheduleLivePanRefresh(panelId, plot, state.latestXRange);
        }
        Plotly.relayout(div, update).finally(() => {
            if (plot._relayoutLiveOnly) this._renderCursorOverlay(plot, { range: state.latestXRange, lightweight: true });
        });
    };

    // Redraw at the panned range and let the full relayout settle (lazy
    // refetch, downsample to the new window, axis sync). Owned by the short
    // settle timer so new points show promptly, not at latch expiry.
    const settle = () => {
        state.settleTimer = 0;
        if (!state.latestXRange) return;
        this._clearLivePanRefresh(plot);
        plot._relayoutLiveOnly = false;
        if (typeof options.finalize === 'function') options.finalize(state.latestXRange);
    };

    const endGesture = () => {
        state.endTimer = 0;
        state.mode = null;
        state.base = null;
        // settle() owns the refresh; run any pending one now so nothing is left
        // half-applied if the latch expires first.
        if (state.settleTimer) { clearTimeout(state.settleTimer); settle(); }
        state.latestXRange = null;
    };

    div.addEventListener('wheel', (event) => {
        // Only PAN is latched. While the latch is alive a vertical event still
        // pans (bridging the lift-and-replace). Otherwise every event is
        // re-evaluated, so a horizontal swipe starts a pan immediately — even
        // right after a vertical zoom, which is never latched.
        if (state.mode !== 'pan') {
            if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
                state.base = captureBase();
                if (state.base) state.mode = 'pan';
            }
        }
        if (state.mode !== 'pan') {
            // Vertical two-finger wheel/pinch is Plotly zoom. Avoid changing
            // trace data mid-zoom; doing so can fight Plotly's zoom transform.
            if (plot.mode === 'timeseries' || plot.mode === 'fft') {
                this._suppressLiveRelayout(plot);
            }
            return;
        }
        // Refresh both timers on each pan event: the long latch keeps pan mode
        // alive (lift-and-replace bridge), the short one refreshes the points.
        clearTimeout(state.endTimer);
        state.endTimer = setTimeout(endGesture, END_MS);
        clearTimeout(state.settleTimer);
        state.settleTimer = setTimeout(settle, SETTLE_MS);
        // Capture-phase stopPropagation keeps the event from Plotly's inner
        // drag-layer wheel handler; preventDefault stops the page/zoom default.
        event.preventDefault();
        event.stopPropagation();
        const scale = deltaScale(event);
        state.pendingDX += event.deltaX * scale;
        state.pendingDY += event.deltaY * scale;
        if (!state.raf) state.raf = requestAnimationFrame(flush);
    }, { capture: true, passive: false });
};

// Right-button drag pans a Plotly pane by manipulating its axis ranges
// directly — Plotly's own drag only reacts to button 0, so without this a
// right-drag falls through to the native zoom-box and snaps to a strange
// scale on release. Generic over the given `div` (time pane, spectrum,
// histogram, …); the trackpad two-finger pan in _installWheelPan is left
// untouched and both share the same live/finalize contract.
proto._installRightButtonPan = function(panelId, plot, div, options = {}) {
    if (!div || div._rightPanBound) return;
    div._rightPanBound = true;

    div.addEventListener('mousedown', (e) => {
        if (e.button !== 2) return;
        const fl = div._fullLayout;
        const xa = fl?.xaxis, ya = fl?.yaxis;
        if (!xa || !ya || !xa._length || !ya._length) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const x0 = xa.range.slice(), y0 = ya.range.slice();
        // Secondary Y only exists (and only pans) on the timeseries chart.
        const y2a = (plot.timeseriesY2Enabled && plot.mode === 'timeseries') ? fl?.yaxis2 : null;
        const y20 = y2a?.range ? y2a.range.slice() : null;
        const xNumeric0 = x0.map(value => this._coerceAxisValue(value));
        const yNumeric0 = y0.map(value => Number(value));
        const y2Numeric0 = y20?.map(value => Number(value)) || null;
        if (!xNumeric0.every(Number.isFinite) || !yNumeric0.every(Number.isFinite)) return;
        const xLen = xa._length, yLen = ya._length;
        const isDateXAxis = xa.type === 'date';
        let latestXRange = x0;
        const formatXRange = (range) => isDateXAxis
            ? range.map(value => new Date(value).toISOString())
            : range;
        const onMove = (mv) => {
            const xSpan = xNumeric0[1] - xNumeric0[0];
            const ySpan = yNumeric0[1] - yNumeric0[0];
            const dx = -((mv.clientX - startX) / xLen) * xSpan;
            const dy =  ((mv.clientY - startY) / yLen) * ySpan;
            latestXRange = formatXRange([xNumeric0[0] + dx, xNumeric0[1] + dx]);
            plot._relayoutLiveOnly = true;
            const update = {
                'xaxis.range': latestXRange,
                'yaxis.range': [yNumeric0[0] + dy, yNumeric0[1] + dy],
            };
            if (y2Numeric0?.every(Number.isFinite) && y2a?._length) {
                const y2Span = y2Numeric0[1] - y2Numeric0[0];
                const dy2 = ((mv.clientY - startY) / y2a._length) * y2Span;
                update['yaxis2.range'] = [y2Numeric0[0] + dy2, y2Numeric0[1] + dy2];
            }
            // Only the TIME pane may live re-fit; the results pane carries a
            // frequency range that would empty the time-pane traces.
            if (div === plot.div && (this.relayoutRefreshMode || 'auto') === 'responsive') {
                this._scheduleLivePanRefresh(panelId, plot, latestXRange);
            }
            Plotly.relayout(div, update).finally(() => {
                if (plot._relayoutLiveOnly) this._renderCursorOverlay(plot, { range: latestXRange, lightweight: true });
            });
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            this._clearLivePanRefresh(plot);
            plot._relayoutLiveOnly = false;
            // Mirror the wheel-pan settle: only the caller-supplied finalize
            // commits the pan (e.g. refetch the time pane). Panes without one
            // (spectrum, histogram) keep the range already applied above.
            if (typeof options.finalize === 'function') options.finalize(latestXRange);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }, { capture: true });

    div.addEventListener('contextmenu', (e) => { e.preventDefault(); });
};

proto._installCursorHandlers = function(panelId, plot) {
    for (const view of this._cursorViews(panelId, plot)) {
        this._installCursorViewHandlers(view);
    }
};

proto._installCursorViewHandlers = function(view) {
    const { panelId, plot } = view;
    const div = this._viewDiv(view);
    const guardKey = `_cursorHandlersDiv_${view.id}`;
    const docKey = `_cursorDocListeners_${view.id}`;
    if (!div || plot[guardKey] === div) return;
    if (plot[docKey]) {
        document.removeEventListener('mousemove', plot[docKey].move);
        document.removeEventListener('mouseup',   plot[docKey].up);
        plot[docKey] = null;
    }
    plot[guardKey] = div;

    let dragging = null;
    const cursorNearPointer = (event) => {
        const cursors = this._viewCursors(view);
        if (!cursors.enabled || !this._plotSupportsCursors(plot)) return null;
        const xa = div?._fullLayout?.xaxis;
        if (!xa || !Number.isFinite(cursors.a) || !Number.isFinite(cursors.b)) return null;
        const x = this._eventToXValue(div, event);
        if (!Number.isFinite(x)) return null;
        const range = xa.range;
        const r0 = this._coerceAxisValue(range?.[0]);
        const r1 = this._coerceAxisValue(range?.[1]);
        const span = Math.abs(r1 - r0) || 1;
        const xLen = Math.abs(xa._length) || 1;
        const tolerance = (5 / xLen) * span;
        const da = Math.abs(x - cursors.a);
        const db = Math.abs(x - cursors.b);
        const near = Math.min(da, db);
        if (near > tolerance) return null;
        return da <= db ? 'a' : 'b';
    };

    div.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;
        const cursors = this._viewCursors(view);
        const hit = cursorNearPointer(event);
        if (!hit) {
            if (cursors.enabled
                && div?._fullLayout?.dragmode !== 'pan'
                && this._eventInsidePlotArea(div, event)) {
                this._beginCursorBoxZoomSuppress(panelId, plot);
            }
            return;
        }
        const x = this._eventToXValue(div, event);
        dragging = event.ctrlKey && Number.isFinite(x)
            ? { mode: 'pair', which: hit, startPointerX: x, startA: cursors.a, startB: cursors.b }
            : { mode: 'single', which: hit };
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        document.body.classList.add('cursor-dragging');
    }, true);

    div.addEventListener('mousemove', (event) => {
        if (dragging || !this._viewCursors(view).enabled) return;
        const near = !!cursorNearPointer(event);
        div.style.cursor = near ? 'ew-resize' : '';
        div.closest('.layout-panel')?.classList.toggle('cursor-near', near);
    });

    div.addEventListener('mouseleave', () => {
        if (!dragging && div) div.style.cursor = '';
        div?.closest('.layout-panel')?.classList.remove('cursor-near');
    });

    const onDocMove = (event) => {
        if (!dragging || !div) return;
        const cursors = this._viewCursors(view);
        const x = this._eventToXValue(div, event);
        if (!Number.isFinite(x)) return;
        if (dragging.mode === 'pair') {
            const delta = this._cursorPairSlideDelta(view, dragging.startA, dragging.startB, x - dragging.startPointerX);
            cursors.a = this._clampCursorX(view, 'a', dragging.startA + delta);
            cursors.b = this._clampCursorX(view, 'b', dragging.startB + delta);
        } else {
            cursors[dragging.which] = this._clampCursorX(view, dragging.which, x);
        }
        // A left-button gesture inside a timeseries plot temporarily enables
        // the box-zoom overlay guard before the cursor hit-test runs. Once a
        // cursor drag is confirmed, its visual overlay must bypass that guard
        // so the vertical line follows every mousemove just like its readout.
        this._syncCursorDisplay(panelId, plot, { force: true });
    };
    const onDocUp = () => {
        if (!dragging) return;
        dragging = null;
        document.body.classList.remove('cursor-dragging');
        div?.closest('.layout-panel')?.classList.remove('cursor-near');
    };
    document.addEventListener('mousemove', onDocMove);
    document.addEventListener('mouseup',   onDocUp);
    plot[docKey] = { move: onDocMove, up: onDocUp };
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

proto._updateCursorBox = function(view) {
    const { panelId, plot } = view;
    const panelEl = plot.div?.closest('.layout-panel');
    if (!panelEl) return;
    const cursors = this._viewCursors(view);
    if (!cursors.enabled) {
        this._hideCursorViewBox(panelEl, view.id);
        return;
    }
    const traceA = this._resolveCursorTrace(view, 'a');
    const traceB = this._resolveCursorTrace(view, 'b');
    if (!traceA && !traceB) {
        this._showCursorBox(view, i18n.t('cursorsNoTrace'));
        return;
    }
    const aX = cursors.a;
    const bX = cursors.b;
    const measure = (trace, x) => {
        if (!trace) return { y: NaN, timeUnit: 's', yUnit: '', name: '' };
        const series   = this._cursorSeriesForTrace(view, trace);
        const mode     = this._cursorInterpolationMode(view, trace);
        const y        = series
            ? this._interpolateAt(series.times, series.values, x, mode)
            : NaN;
        const variable = this.files.get(trace.fileId)?.data?.variables?.[trace.varName];
        return {
            y,
            fileId: trace.fileId,
            timeUnit: view.isSpectrum ? '' : this._timeUnitLabel(trace.fileId),
            yUnit: view.isSpectrum
                ? this._fftCursorAmplitudeUnit(plot)
                : (variable ? this._extractUnit(variable.description) : ''),
            name:     this._traceName(trace.varName, trace.fileId),
        };
    };
    const a = measure(traceA, aX);
    const b = measure(traceB, bX);
    const spectrum = view.isSpectrum ? spectrumCursorMeasurements(aX, bX) : null;
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
    const inverseTimeUnit = view.isSpectrum
        ? this._fftCursorPeriodUnit(plot)
        : isDateTimeCursor || isDurationCursor
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
        view.id,
        i18n.currentLang,
        optionsKey,
        traceKey(traceA),
        traceKey(traceB),
        colorA,
        colorB,
        sameTrace ? 'same' : 'different',
        cursors.showSecant ? 'secant' : 'no-secant',
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
    const secantChecked = cursors.showSecant ? ' checked' : '';
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
    // Spectrum view: x is frequency; each cursor also reads its own period
    // T = 1/|f|. Δf is the absolute cursor separation, and 1/Δf is presented
    // as the inverse frequency spacing (a beat period only when A and B mark
    // two real nearby components — see the help popover). The slope has no
    // physical meaning there.
    const xLabel = view.isSpectrum ? 'f' : labelX;
    const dxLabel = view.isSpectrum ? '&Delta;f' : labelDx;
    const invDxLabel = view.isSpectrum ? '1/&Delta;f' : labelInvDx;
    const freqUnit = view.isSpectrum ? this._fftCursorFrequencyUnit(plot) : '';
    const formatCursorNumber = (value) => (value === Infinity
        ? '&infin;'
        : value === -Infinity ? '-&infin;' : this._formatHTMLNumber(value));
    const formatXValue = (m, x) => (view.isSpectrum
        ? formatCursorNumber(x)
        : this._escapeHTML(this._formatTimeValue(m.fileId, x)));
    const xUnitSuffix = view.isSpectrum
        ? unit(freqUnit)
        : ((isDateTimeCursor || isDurationCursor) ? '' : unit(timeUnit));
    const formatPeriod = (period) => this._escapeHTML(formatSpectrumPeriod(period, inverseTimeUnit));
    const dxText = view.isSpectrum
        ? `${formatCursorNumber(spectrum.deltaF)}${unit(freqUnit)}`
        : `${this._escapeHTML(isDateTimeCursor ? this._formatDuration(dx, 'datetime') : (isDurationCursor ? this._formatDuration(dx, 's') : this._formatHTMLNumber(dx)))}${(isDateTimeCursor || isDurationCursor) ? '' : unit(timeUnit)}`;
    const inverseDxValue = view.isSpectrum ? spectrum.inverseDeltaF : inverseDx;
    const inverseDxText = view.isSpectrum
        ? formatPeriod(inverseDxValue)
        : `${formatCursorNumber(inverseDxValue)}${unit(inverseTimeUnit)}`;
    const inverseSpacingHTML = view.isSpectrum
        ? `
            <div class="cursor-inverse-spacing-note">${this._escapeHTML(i18n.t('fftCursorInverseSpacing'))}
                <button type="button" class="fft-help-btn cursor-help-btn" title="${this._escapeHTML(i18n.t('fftCursorInverseSpacing'))}" aria-expanded="false">?</button>
            </div>
            <div class="fft-help-popover cursor-help-popover" hidden>${this._escapeHTML(i18n.t('fftCursorInverseSpacingHelp'))}</div>`
        : '';
    const spectrumCursorRows = (letter, color, measurement, x, period) => `
            <div class="cursor-spectrum-frequency-row"><b style="color:${color}">${letter}</b> ${xLabel}=${formatXValue(measurement, x)}${xUnitSuffix} ${labelY}=${this._formatHTMLNumber(measurement.y)}${unit(measurement.yUnit)}</div>
            <div class="cursor-spectrum-period-row">T=${formatPeriod(period)}</div>`;
    const cursorRowsHTML = view.isSpectrum
        ? `${spectrumCursorRows('A', colorA, a, aX, spectrum.periodA)}
           ${spectrumCursorRows('B', colorB, b, bX, spectrum.periodB)}`
        : `<div><b style="color:${colorA}">A</b> ${xLabel}=${formatXValue(a, aX)}${xUnitSuffix} ${labelY}=${this._formatHTMLNumber(a.y)}${unit(a.yUnit)}</div>
           <div><b style="color:${colorB}">B</b> ${xLabel}=${formatXValue(b, bX)}${xUnitSuffix} ${labelY}=${this._formatHTMLNumber(b.y)}${unit(b.yUnit)}</div>`;
    const valuesHTML = `
            ${cursorRowsHTML}
            <div><b>${dxLabel}=</b>${dxText}</div>
            <div><b>${labelDy}=</b>${this._formatHTMLNumber(dy)}${sameUnit ? unit(a.yUnit) : ''}</div>
            ${view.isSpectrum ? '' : `<div><b>${labelSlope}=</b>${this._formatHTMLNumber(slope)}</div>`}
            <div><b>${invDxLabel}=</b>${inverseDxText}</div>
            ${inverseSpacingHTML}
    `;
    const existingBox = this._cursorViewBoxElement(panelEl, view.id);
    if (existingBox?.dataset.cursorSignature === boxSignature) {
        const valuesEl = existingBox.querySelector('.cursor-info-values');
        if (valuesEl) {
            // The help popover lives inside the values area: keep it open
            // across the value refreshes that happen while dragging.
            const helpWasOpen = !!valuesEl.querySelector('.cursor-help-popover:not([hidden])');
            valuesEl.innerHTML = valuesHTML;
            if (helpWasOpen) {
                const popover = valuesEl.querySelector('.cursor-help-popover');
                if (popover) popover.hidden = false;
                valuesEl.querySelector('.cursor-help-btn')?.setAttribute('aria-expanded', 'true');
                this._positionCursorHelpPopover(existingBox);
            }
        }
        this._applyCursorBoxPosition(panelEl, existingBox, view);
        existingBox.style.display = 'block';
        return;
    }
    const titleSuffix = plot.mode === 'fft'
        ? ` — ${i18n.t(view.isSpectrum ? 'fftCursorSpectrumSection' : 'fftCursorTimeSection')}`
        : '';
    const html = `
        <div class="cursor-info-header">
            <span class="cursor-info-title">${moveIcon}${this._escapeHTML(i18n.t('cursorsToggle') + titleSuffix)}</span>
            <button type="button" class="cursor-close-btn" title="${this._escapeHTML(i18n.t('cursorClose'))}" aria-label="${this._escapeHTML(i18n.t('cursorClose'))}">×</button>
        </div>
        ${selectorsHTML}
        ${view.isSpectrum ? '' : secantHTML}
        <div class="cursor-info-hint">
            <div>${shiftHint}</div>
            <div>${slideHint}</div>
        </div>
        <div class="cursor-info-values">
            ${valuesHTML}
        </div>
    `;
    const box = this._showCursorBox(view, html);
    if (box) box.dataset.cursorSignature = boxSignature;
};

proto._fftCursorFrequencyUnit = function(plot) {
    return String(this._fftFrequencyUnitSuffix?.(plot) || '').replace(/[[\]]/g, '').trim();
};

proto._fftCursorAmplitudeUnit = function(plot) {
    return String(this._fftAmplitudeUnitSuffix?.(plot) || '').replace(/[[\]]/g, '').trim();
};

proto._fftCursorPeriodUnit = function(plot) {
    const trace = (plot?.traces || []).find(item => this._isVisible(item)) || plot?.traces?.[0];
    if (trace && this._fftTimeKind?.(trace.fileId) === 'index') return i18n.t('fftSampleUnit');
    const freqUnit = this._fftCursorFrequencyUnit(plot);
    if (!freqUnit || freqUnit === 'Hz') return 's';
    const inverse = freqUnit.match(/^1\/(.+)$/);
    return inverse ? inverse[1] : `1/${freqUnit}`;
};

// Floats the help popover (position: fixed) next to its button, clamped to
// the viewport so it never truncates when the box sits near a panel edge.
proto._positionCursorHelpPopover = function(box) {
    const btn = box?.querySelector('.cursor-help-btn');
    const popover = box?.querySelector('.cursor-help-popover');
    if (!btn || !popover || popover.hidden) return;
    const margin = 8;
    const btnRect = btn.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    let left = Math.min(btnRect.right - width, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    let top = btnRect.bottom + 6;
    if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, btnRect.top - height - 6);
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
};

proto._cursorViewBoxElement = function(panelEl, viewId) {
    return panelEl?.querySelector(`.cursor-info-box[data-cursor-view="${viewId}"]`)
        // Pre-view boxes had no scope attribute; treat them as the main box.
        || (viewId === 'main' ? panelEl?.querySelector('.cursor-info-box:not([data-cursor-view])') : null);
};

proto._showCursorBox = function(view, html) {
    const { panelId, plot } = view;
    const panelEl = plot.div?.closest('.layout-panel');
    if (!panelEl) return null;
    let box = this._cursorViewBoxElement(panelEl, view.id);
    if (!box) {
        box = document.createElement('div');
        box.className = 'cursor-info-box';
        box.dataset.cursorView = view.id;
        panelEl.appendChild(box);
    }
    box.dataset.cursorView = view.id;
    box.innerHTML = html;
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
            const cursors = this._viewCursors(view);
            const visibleTraces = plot.traces
                .filter(t => t.visible !== false && t.visible !== 'legendonly');
            const selectedTrace = visibleTraces[Number(event.target.value)];
            if (!selectedTrace) return;
            const key = which === 'b' ? 'traceB' : 'traceA';
            cursors[key] = { fileId: selectedTrace.fileId, varName: selectedTrace.varName };
            cursors[which] = this._clampCursorX(view, which, cursors[which]);
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
            this._jumpCursorTo(view, which, target, direction);
        });
    });
    const secantCheckbox = box.querySelector('.cursor-secant-checkbox');
    if (secantCheckbox) {
        secantCheckbox.addEventListener('change', (e) => {
            e.stopPropagation();
            this._viewCursors(view).showSecant = !!e.target.checked;
            this._syncCursorDisplay(panelId, plot);
        });
    }
    if (!box._helpBound) {
        // Delegated so the binding survives the innerHTML swaps of the
        // values area while cursors are being dragged.
        box._helpBound = true;
        // The panel-level mousedown re-renders the box contents (same reason
        // the extremum buttons stop it): without this, the button is replaced
        // before its click event ever fires.
        box.addEventListener('mousedown', (e) => {
            if (e.target.closest('.cursor-help-btn') || e.target.closest('.cursor-help-popover') || e.target.closest('.cursor-close-btn')) {
                e.stopPropagation();
            }
        });
        box.addEventListener('click', (e) => {
            if (e.target.closest('.cursor-close-btn')) {
                e.preventDefault();
                e.stopPropagation();
                this._closeCursorView(panelId, plot, view);
                return;
            }
            const helpBtn = e.target.closest('.cursor-help-btn');
            const popover = box.querySelector('.cursor-help-popover');
            if (helpBtn && popover) {
                e.preventDefault();
                e.stopPropagation();
                const show = popover.hidden;
                popover.hidden = !show;
                helpBtn.setAttribute('aria-expanded', String(show));
                if (show) this._positionCursorHelpPopover(box);
                return;
            }
            if (!e.target.closest('.cursor-help-popover')) {
                const openPopover = box.querySelector('.cursor-help-popover:not([hidden])');
                if (openPopover) {
                    openPopover.hidden = true;
                    box.querySelector('.cursor-help-btn')?.setAttribute('aria-expanded', 'false');
                }
            }
        });
    }
    this._ensureCursorBoxDrag(view, box);
    // Displayed before positioning: the spectrum default position needs the
    // box measurable (offsetWidth is 0 while display is none).
    box.style.display = 'block';
    this._applyCursorBoxPosition(panelEl, box, view);
    return box;
};

proto._applyCursorBoxPosition = function(panelEl, box, view) {
    let pos = this._viewCursors(view).boxPos;
    if (!pos && view.isSpectrum && box.offsetWidth) {
        // First display of the spectrum box: right-aligned, stacked under
        // the time-pane box, clamped inside the panel — a box hanging past
        // the panel edge would sit under the neighboring panel's chart and
        // swallow every click.
        const panelRect = panelEl.getBoundingClientRect();
        const mainBox = this._cursorViewBoxElement(panelEl, 'main');
        const maxX = Math.max(6, panelRect.width - box.offsetWidth - 10);
        const maxY = Math.max(6, panelRect.height - box.offsetHeight - 6);
        let y = 42;
        if (mainBox && mainBox.style.display !== 'none') {
            const mainRect = mainBox.getBoundingClientRect();
            y = mainRect.bottom - panelRect.top + 8;
        }
        pos = {
            x: maxX,
            y: Math.min(maxY, Math.max(6, y)),
        };
        this._viewCursors(view).boxPos = pos;
    }
    if (!pos) return;
    box.style.left = `${pos.x}px`;
    box.style.top = `${pos.y}px`;
    box.style.right = 'auto';
};

proto._ensureCursorBoxDrag = function(view, box = null) {
    const { plot } = view;
    const panelEl = plot.div?.closest('.layout-panel');
    box = box || this._cursorViewBoxElement(panelEl, view.id);
    if (!panelEl || !box || box._dragBound) return;
    box._dragBound = true;
    let drag = null;

    box.addEventListener('mousedown', (event) => {
        if (!event.target.closest('.cursor-info-header')) return;
        if (event.target.closest('.cursor-close-btn')) return; // let the close click through
        event.preventDefault();
        event.stopPropagation();
        // The help popover is position:fixed; it would stay behind while
        // the box moves, so close it when a drag starts.
        const openPopover = box.querySelector('.cursor-help-popover:not([hidden])');
        if (openPopover) {
            openPopover.hidden = true;
            box.querySelector('.cursor-help-btn')?.setAttribute('aria-expanded', 'false');
        }
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
        this._viewCursors(view).boxPos = { x, y };
        this._applyCursorBoxPosition(panelEl, box, view);
    });

    document.addEventListener('mouseup', () => {
        if (!drag) return;
        drag = null;
        document.body.classList.remove('cursor-box-dragging');
    });
};

proto._hideCursorViewBox = function(panelEl, viewId) {
    const box = this._cursorViewBoxElement(panelEl, viewId);
    if (box) box.style.display = 'none';
};

proto._hideCursorBox = function(panelEl) {
    panelEl?.querySelectorAll('.cursor-info-box').forEach(box => {
        box.style.display = 'none';
    });
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
    toolbar.querySelectorAll('.mode-btn-group, .timeseries-tools-group, .view-btn-group, .phase2d-tools-group').forEach(el => el.remove());
    toolbar.querySelectorAll('.panel-action-btn').forEach(el => el.remove());

    const plot = this.plots.get(panelId);
    const timeseriesFamilyModes = new Set(['timeseries', 'fft', 'histogram', 'heatmap', 'temporal-profile']);
    const phase2dFamilyModes = new Set(['phase2d', 'correlation']);
    const isTimeseriesFamily = timeseriesFamilyModes.has(currentMode);
    const isPhase2dFamily = phase2dFamilyModes.has(currentMode);
    const activePrimaryMode = isTimeseriesFamily ? 'timeseries' : (isPhase2dFamily ? 'phase2d' : currentMode);
    const createAutoscaleButton = () => {
        const button = document.createElement('button');
        button.className = 'layout-toolbar-btn panel-action-btn view-btn panel-autoscale-btn';
        // Keep this icon identical to the global "Auto-fit all plots" action.
        button.textContent = '⛶';
        button.title = i18n.t('viewHome');
        button.disabled = !this._hasContent(plot);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            this._autoScalePlot(panelId, this.plots.get(panelId));
        });
        return button;
    };

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
        const isActive = m.id === activePrimaryMode && (m.id !== 'state-anim' || (plot?.stateAnimDim || 2) === m.stateAnimDim);
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

    if (isTimeseriesFamily) {
        const timeseriesToolsGroup = document.createElement('div');
        timeseriesToolsGroup.className = 'timeseries-tools-group';

        timeseriesToolsGroup.appendChild(createAutoscaleButton());

        const stackBtn = document.createElement('button');
        stackBtn.className = 'layout-toolbar-btn panel-action-btn panel-toggle-btn timeseries-stack-btn' + (plot?.timeseriesStacked ? ' active' : '');
        stackBtn.textContent = i18n.t('timeseriesStackLabel');
        stackBtn.title = i18n.t('timeseriesStackToggle');
        stackBtn.disabled = !(this._hasContent(plot) && plot?.mode === 'timeseries');
        stackBtn.setAttribute('aria-pressed', plot?.timeseriesStacked ? 'true' : 'false');
        stackBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleTimeseriesStack(panelId);
        });
        timeseriesToolsGroup.appendChild(stackBtn);

        const y2Btn = document.createElement('button');
        y2Btn.className = 'layout-toolbar-btn panel-action-btn panel-toggle-btn timeseries-y2-btn' + (plot?.timeseriesY2Enabled ? ' active' : '');
        y2Btn.textContent = i18n.t('timeseriesY2Label');
        y2Btn.title = i18n.t('timeseriesY2Toggle');
        y2Btn.disabled = !(this._hasContent(plot) && plot?.mode === 'timeseries');
        y2Btn.setAttribute('aria-pressed', plot?.timeseriesY2Enabled ? 'true' : 'false');
        y2Btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleTimeseriesY2(panelId);
        });
        timeseriesToolsGroup.appendChild(y2Btn);

        const missingBtn = document.createElement('button');
        missingBtn.className = 'layout-toolbar-btn panel-action-btn panel-toggle-btn timeseries-missing-btn' + (plot?.showMissingData ? ' active' : '');
        missingBtn.textContent = i18n.t('timeseriesMissingLabel');
        missingBtn.title = i18n.t('timeseriesMissingToggle');
        missingBtn.disabled = !(this._hasContent(plot) && plot?.mode === 'timeseries');
        missingBtn.setAttribute('aria-pressed', plot?.showMissingData ? 'true' : 'false');
        missingBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleMissingData(panelId);
        });
        timeseriesToolsGroup.appendChild(missingBtn);

        const analysisModes = [
            { id: 'fft', label: 'Fourier', titleKey: 'modeFFT', className: 'timeseries-fourier-btn' },
            { id: 'histogram', label: i18n.t('modeHistogramLabel'), titleKey: 'modeHistogram', className: 'timeseries-histogram-btn' },
            { id: 'heatmap', label: i18n.t('modeHeatmapLabel'), titleKey: 'modeHeatmap', className: 'timeseries-heatmap-btn' },
            { id: 'temporal-profile', label: i18n.t('temporalProfileModeLabel'), titleKey: 'temporalProfileMode', className: 'timeseries-temporal-profile-btn' },
        ];
        analysisModes.forEach(({ id, label, titleKey, className }) => {
            const active = currentMode === id;
            const button = document.createElement('button');
            button.className = `layout-toolbar-btn panel-action-btn panel-toggle-btn timeseries-analysis-btn ${className}${active ? ' active' : ''}`;
            button.textContent = label;
            button.title = i18n.t(titleKey);
            button.dataset.mode = id;
            button.setAttribute('aria-pressed', String(active));
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                this._toggleTimeseriesAnalysisMode(panelId, id);
            });
            timeseriesToolsGroup.appendChild(button);
        });
        toolbar.appendChild(timeseriesToolsGroup);
    }

    // Contextual view buttons. In 2D modes this group contains Autoscale and
    // 1:1; 3D modes add their camera/projection controls after Autoscale.
    const viewGroup = document.createElement('div');
    viewGroup.className = 'view-btn-group';
    const supportsEqualAspect2D = this._supportsEqualAspect2D(plot);
    const show3DControls = this._is3D(currentMode) || this._isStateAnim3D(plot);
    viewGroup.style.display = (show3DControls || supportsEqualAspect2D || isPhase2dFamily) ? '' : 'none';

    if (!isTimeseriesFamily) {
        viewGroup.appendChild(createAutoscaleButton());
    }

    if (supportsEqualAspect2D) {
        const equalAspectBtn = document.createElement('button');
        equalAspectBtn.className = 'layout-toolbar-btn panel-action-btn panel-toggle-btn equal-aspect-btn' + (plot?.equalAspect2D ? ' active' : '');
        equalAspectBtn.textContent = '1:1';
        equalAspectBtn.title = i18n.t('equalAspect2D');
        equalAspectBtn.setAttribute('aria-pressed', String(!!plot?.equalAspect2D));
        equalAspectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleEqualAspect2D(panelId);
        });
        viewGroup.appendChild(equalAspectBtn);
    }

    // Correlation is an analysis toggle of the 2D/pair family (shares the pair
    // list). Appended AFTER the 2D Display controls (below) so it reads as its
    // own toggle, not as a label for the Display dropdown.
    let phase2dCorrelationBtn = null;
    if (isPhase2dFamily) {
        const corrActive = currentMode === 'correlation';
        phase2dCorrelationBtn = document.createElement('button');
        phase2dCorrelationBtn.className = 'layout-toolbar-btn panel-action-btn panel-toggle-btn correlation-toggle-btn' + (corrActive ? ' active' : '');
        phase2dCorrelationBtn.textContent = i18n.t('modeCorrelationLabel');
        phase2dCorrelationBtn.title = i18n.t('modeCorrelation');
        phase2dCorrelationBtn.setAttribute('aria-pressed', String(corrActive));
        phase2dCorrelationBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._toggleCorrelationMode(panelId);
        });
    }

    const is2dt = currentMode === 'phase2dt';
    const views = [
        { preset: 'top',   label: is2dt ? 'x vs t' : 'XY', titleKey: is2dt ? 'view2dtXt' : 'viewTop'   },
        { preset: 'front', label: is2dt ? 'y vs t' : 'XZ', titleKey: is2dt ? 'view2dtYt' : 'viewFront' },
        { preset: 'yz',    label: is2dt ? 'y vs x' : 'YZ', titleKey: is2dt ? 'view2dtXY' : 'viewSide'  },
    ];

    views.forEach(v => {
        const btn = document.createElement('button');
        btn.className = 'layout-toolbar-btn view-btn view-btn-3d-only';
        btn.textContent = v.label;
        btn.title = i18n.t(v.titleKey);
        btn.style.display = show3DControls ? '' : 'none';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._setCamera(panelId, v.preset === 'yz' ? 'yz' : v.preset);
        });
        viewGroup.appendChild(btn);
    });

    // Projection toggle button (Iso / Persp)
    const isOrtho = !plot || plot.projection === 'orthographic';
    const projBtn = document.createElement('button');
    projBtn.className = 'layout-toolbar-btn view-btn proj-btn view-btn-3d-only' + (isOrtho ? ' active' : '');
    projBtn.textContent = 'Iso';
    projBtn.title = i18n.t(isOrtho ? 'projIsometric' : 'projPerspective');
    projBtn.style.display = show3DControls ? '' : 'none';
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
        btn.style.display = show3DControls ? '' : 'none';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._animateRotation(panelId, r.axis, Math.PI / 2, 400);
        });
        viewGroup.appendChild(btn);
    });

    toolbar.appendChild(viewGroup);

    // 2D-only Display (Lines / Points / Lines+points) + marker controls (TODO 10),
    // then the Correlation toggle last so the Display dropdown is not mistaken
    // for a Correlation option.
    this._injectPhase2dDisplayControls?.(panelId, toolbar, plot);
    if (phase2dCorrelationBtn) toolbar.appendChild(phase2dCorrelationBtn);

    // Compare (overlay traces from other files) — left of CSV
    const compareBtn = document.createElement('button');
    compareBtn.className = 'layout-toolbar-btn panel-action-btn compare-files-btn';
    compareBtn.textContent = '⧉';
    compareBtn.title = i18n.t('compareFiles');
    const canCompare = this._hasContent(plot)
        && plot.mode !== 'state-anim'
        && plot.mode !== 'fft'
        && plot.mode !== 'heatmap'
        && plot.mode !== 'temporal-profile'
        && plot.mode !== 'correlation'
        && this.files.size > 1;
    compareBtn.disabled = !canCompare;
    compareBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._compareAcrossFiles(panelId);
    });
    toolbar.appendChild(compareBtn);

    const cursorBtn = document.createElement('button');
    cursorBtn.className = 'layout-toolbar-btn panel-action-btn cursor-btn' + (this._anyCursorEnabled(plot) ? ' active' : '');
    cursorBtn.textContent = 'A|B';
    cursorBtn.title = i18n.t('cursorsToggle');
    cursorBtn.disabled = !(this._hasContent(plot) && this._plotSupportsCursors(plot));
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

proto._toggleTimeseriesAnalysisMode = function(panelId, analysisMode) {
    if (!['fft', 'histogram', 'heatmap', 'temporal-profile'].includes(analysisMode)) return;
    const plot = this.plots.get(panelId);
    if (!plot) return;
    const targetMode = plot.mode === analysisMode ? 'timeseries' : analysisMode;
    this._requestModeChange(panelId, targetMode);
};

proto._requestModeChange = function(panelId, mode, stateAnimDim = null) {
    const plot = this.plots.get(panelId);
    if (!plot) return;
    const nextDim = mode === 'state-anim' ? (stateAnimDim || plot.stateAnimDim || 2) : plot.stateAnimDim;
    if (plot.mode === mode && plot.stateAnimDim === nextDim) {
        this._dismissModeChangeWarning(panelId);
        return;
    }
    const timeTraceModes = new Set(['timeseries', 'fft', 'histogram', 'heatmap', 'temporal-profile']);
    const preservesTimeTraces = timeTraceModes.has(plot.mode) && timeTraceModes.has(mode);
    if (preservesTimeTraces) {
        this._setMode(panelId, mode, stateAnimDim, { preserveTimeTraces: true });
        return;
    }
    // phase2d ↔ correlation keep the shared pair list; switch without warning.
    const phasePairModes = new Set(['phase2d', 'correlation']);
    if (phasePairModes.has(plot.mode) && phasePairModes.has(mode)) {
        this._setMode(panelId, mode, stateAnimDim);
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
    const activePrimaryMode = ['timeseries', 'fft', 'histogram', 'heatmap', 'temporal-profile'].includes(activeMode)
        ? 'timeseries'
        : activeMode;
    panelEl.querySelectorAll('.mode-btn').forEach(btn => {
        const mode = btn.dataset.mode;
        const dim = btn.dataset.stateAnimDim ? Number(btn.dataset.stateAnimDim) : null;
        btn.classList.toggle('active', mode === activePrimaryMode && (!dim || dim === (plot?.stateAnimDim || 2)));
    });
    panelEl.querySelectorAll('.timeseries-analysis-btn').forEach(btn => {
        const active = btn.dataset.mode === activeMode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
    });
};

proto._toggle3DViewButtons = function(panelEl, show) {
    const group = panelEl.querySelector('.view-btn-group');
    if (group) group.style.display = show ? '' : 'none';
};

proto._toggleTimeseriesStack = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot || plot.mode !== 'timeseries') return;
    plot.timeseriesStacked = !plot.timeseriesStacked;
    if (plot.timeseriesStacked && plot.timeseriesY2Enabled) {
        plot.timeseriesY2Enabled = false;
        plot.traces.forEach(trace => { trace.axis = 'y'; });
    }
    const capturedView = plot.div ? this._capturePlotView(plot) : null;
    let restoreView = null;
    if (capturedView?.mode === '2d') {
        const traceSeries = [];
        const yArrays = [];
        for (const trace of plot.traces.filter(t => this._isVisible(t))) {
            const data = this.files.get(trace.fileId)?.data;
            const variable = data?.variables?.[trace.varName];
            if (!variable || variable.kind === 'parameter') continue;
            const x = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
            const y = this._getTransformedVariableData(trace.fileId, trace.varName);
            traceSeries.push({ x, y });
            yArrays.push(y);
        }
        const yExtent = this._timeseriesYExtentForSeries(plot, traceSeries, yArrays, capturedView.xRange);
        restoreView = {
            ...capturedView,
            yRange: yExtent ? this._padRange(yExtent.min, yExtent.max) : null,
        };
    }

    const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
    const btn = panelEl?.querySelector('.timeseries-stack-btn');
    if (btn) {
        btn.classList.toggle('active', !!plot.timeseriesStacked);
        btn.setAttribute('aria-pressed', plot.timeseriesStacked ? 'true' : 'false');
    }
    const y2Btn = panelEl?.querySelector('.timeseries-y2-btn');
    if (y2Btn) {
        y2Btn.classList.toggle('active', !!plot.timeseriesY2Enabled);
        y2Btn.setAttribute('aria-pressed', plot.timeseriesY2Enabled ? 'true' : 'false');
    }

    if (plot.div) {
        this._rebuildPanel(panelId, { restoreView: restoreView || capturedView });
    } else {
        this._refreshActionBtns(panelId);
    }
};

proto._toggleCorrelationMode = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot) return;
    if (plot.mode !== 'phase2d' && plot.mode !== 'correlation') return;
    // _setMode preserves phaseTraces/pending across the phase2d↔correlation pair family.
    this._setMode(panelId, plot.mode === 'correlation' ? 'phase2d' : 'correlation');
};

proto._toggleMissingData = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot || plot.mode !== 'timeseries') return;
    const capturedView = plot.div ? this._capturePlotView(plot) : null;
    plot.showMissingData = !plot.showMissingData;

    const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
    const btn = panelEl?.querySelector('.timeseries-missing-btn');
    if (btn) {
        btn.classList.toggle('active', !!plot.showMissingData);
        btn.setAttribute('aria-pressed', plot.showMissingData ? 'true' : 'false');
    }

    // Turning the flag off must also drop the "too dense" hint. Either way,
    // invalidate the lazy Missing/NaN cache so a re-enable re-queries fresh.
    plot._lazyMissSig = null;
    if (!plot.showMissingData) {
        this._cancelLazyMissingRequest(panelId);
        this._setMissingDensityNotice(plot, false);
    }

    // Rebuild rather than restyle: turning the flag off must both remove the
    // bands (layout shapes) and reconnect the line (drop the NaN breaks).
    if (plot.div) this._rebuildPanel(panelId, { restoreView: capturedView });
    else this._refreshActionBtns(panelId);
};

proto._toggleTimeseriesY2 = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot || plot.mode !== 'timeseries') return;
    const capturedView = plot.div ? this._capturePlotView(plot) : null;
    plot.timeseriesY2Enabled = !plot.timeseriesY2Enabled;
    if (plot.timeseriesY2Enabled) {
        plot.timeseriesStacked = false;
    } else {
        plot.traces.forEach(trace => { trace.axis = 'y'; });
    }

    const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
    const y2Btn = panelEl?.querySelector('.timeseries-y2-btn');
    if (y2Btn) {
        y2Btn.classList.toggle('active', !!plot.timeseriesY2Enabled);
        y2Btn.setAttribute('aria-pressed', plot.timeseriesY2Enabled ? 'true' : 'false');
    }
    const stackBtn = panelEl?.querySelector('.timeseries-stack-btn');
    if (stackBtn) {
        stackBtn.classList.toggle('active', !!plot.timeseriesStacked);
        stackBtn.setAttribute('aria-pressed', plot.timeseriesStacked ? 'true' : 'false');
    }

    if (plot.div) {
        this._rebuildPanel(panelId, { restoreView: capturedView });
    } else {
        this._refreshActionBtns(panelId);
    }
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
    if (btn) {
        btn.classList.toggle('active', plot.equalAspect2D);
        btn.setAttribute('aria-pressed', String(plot.equalAspect2D));
    }
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
        case 'fft':
            msg = i18n.t('dropFftMulti');
            break;
        case 'histogram':
            msg = i18n.t('dropHistogramMulti');
            break;
        case 'heatmap':
            msg = i18n.t('dropHeatmapMulti');
            break;
        case 'temporal-profile':
            msg = i18n.t('temporalProfileDrop');
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
