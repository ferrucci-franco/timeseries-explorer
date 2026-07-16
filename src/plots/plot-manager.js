import i18n from '../i18n/index.js';
import Modal from '../ui/modal.js';
import Plotly from '../vendor/plotly.js';
import { getPlotlyLocale, normalizeAppLanguage } from './plotly-locale.js';
import { installPlotDataMethods } from './methods/data-methods.js';
import { installPlotStateMethods } from './methods/state-methods.js';
import { installPlotInteractionMethods } from './methods/interaction-methods.js';
import { installPlotFftMethods } from './methods/fft-methods.js';
import { installPlotHistogramMethods } from './methods/histogram-methods.js';
import { installPlotCorrelationMethods } from './methods/correlation-methods.js';
import { installPlotCalendarHeatmapMethods } from './methods/heatmap-methods.js';

/**
 * PlotManager — Plotly chart lifecycle tied to the dynamic layout
 *
 * Panel modes:
 *   'timeseries'  — one or more variables vs time (default)
 *   'phase2d'     — x(t) vs y(t)  → 2-D scatter
 *   'phase2dt'    — x(t) vs y(t) vs t → 3-D scatter (plotly X=time, Y=var x, Z=var y)
 *   'phase3d'     — x(t) vs y(t) vs z(t) → 3-D scatter
 *
 * Panel state per panelId:
 *   { div, mode, traces:[{varName,color}], phaseTraces:[{x,y,z,color}], phasePending:{x,y,z}, resizeObserver }
 */

class PlotManager {
    constructor(parser) {
        this.parser         = parser || null;
        this.plots          = new Map();
        this.files          = new Map();   // fileId → { name, data }
        this.activeFileId   = null;
        this.theme          = 'light';
        this.language       = 'en';
        this.syncAxes       = true;
        this.legendPosition = 'overlay';
        this.legendOverlayCorner = 'tl';
        this.timeseriesVisualMaxPoints = PlotManager.DEFAULT_VISUAL_MAX_POINTS_TIMESERIES;
        this.phaseVisualMaxPoints = PlotManager.DEFAULT_VISUAL_MAX_POINTS_PHASE;
        this.relayoutRefreshMode = 'auto';
        this._syncing       = false;
        this._syncSourcePanelId = null;
        this._pendingAxisSync = null;
        this.syncHover      = false;
        this.hoverInfoCorner = 'bl';
        this.hoverProximity = true;
        this.mouseWheelZoom = true;
        this.liveViewDefaults = {
            timeseries: { xMode: 'pin-start', windowSeconds: 60, yMode: 'expand' },
            phase: { viewMode: 'keep' },
        };
        this._hovering      = false;

        this.onPanelMount   = (id, el) => this._mountPanel(id, el);
        this.onPanelUnmount = (id)     => this._unmountPanel(id);
    }

    // ─── Public API ────────────────────────────────────────────────

    /** Active file's data — used as fallback / for addTrace validation */
    get data() {
        return this.activeFileId ? (this.files.get(this.activeFileId)?.data ?? null) : null;
    }

    addFile(fileId, name, data, transform = null) {
        const wasOne = this.files.size === 1;
        this.files.set(fileId, {
            name,
            data,
            transform: this._normalizeFileTransform(transform),
            _transformCache: null,
        });
        this.activeFileId = fileId;
        // If going 1→2 files, rebuild all panels so legend labels gain [filename]
        if (wasOne) this._rebuildAllPanels();
    }

    setActiveFile(fileId) {
        if (this.files.has(fileId)) this.activeFileId = fileId;
    }

    removeFile(fileId) {
        const goingToOne = this.files.size === 2;
        const affectedPanels = new Set();

        for (const [panelId, plot] of this.plots) {
            if (['timeseries', 'fft', 'histogram', 'heatmap'].includes(plot.mode)) {
                const before = plot.traces.length;
                plot.traces = plot.traces.filter(t => t.fileId !== fileId);
                if (plot.traces.length < before) affectedPanels.add(panelId);
            } else {
                const before = plot.phaseTraces.length;
                plot.phaseTraces = plot.phaseTraces.filter(t => t.fileId !== fileId);
                if (plot.phaseTraces.length < before) affectedPanels.add(panelId);
                if (plot.phasePending?.fileId === fileId) {
                    plot.phasePending = { x: null, y: null, z: null, fileId: null };
                }
            }
        }

        this.files.delete(fileId);
        if (this.activeFileId === fileId) {
            this.activeFileId = this.files.size > 0 ? [...this.files.keys()][0] : null;
        }

        // If going 2→1, rebuild all (legend labels lose [filename]); else rebuild affected only
        if (goingToOne) {
            this._rebuildAllPanels();
        } else {
            for (const id of affectedPanels) this._rebuildPanel(id);
        }
    }

    updateFileData(fileId, newData, options = {}) {
        const entry = this.files.get(fileId);
        if (!entry) return;
        const previousData = entry.data;
        entry.data = newData;
        entry._transformCache = null;
        // Rebuild every panel that has at least one trace from this file
        for (const [panelId, plot] of this.plots) {
            const uses = plot.traces.some(t => t.fileId === fileId) ||
                         plot.phaseTraces.some(t => t.fileId === fileId) ||
                         plot.stateSlots?.fileId === fileId;
            if (!uses) continue;
            // The missing-data / sampling-gap overlays memoize by a time-only
            // signature, which does not change when a data tool alters a
            // variable's VALUES (e.g. NaN -> interpolated). Drop those caches so
            // the bands recompute against the new data instead of persisting.
            plot._missSig = null; plot._missCache = null;
            plot._fftGapsSig = null; plot._fftGapsCache = null;
            // A lazy Heatmap must not silently re-scan a multi-GB file on every
            // live poll: flag it dirty and let the user click Update. Eager
            // Heatmaps and every other mode recompute as before.
            if (options.liveAppend
                && plot.mode === 'heatmap'
                && plot.traces.some(t => t.fileId === fileId && !!this.files.get(t.fileId)?.data?._duckdb)) {
                this._markCalendarHeatmapDirty?.(panelId);
                continue;
            }
            const captured = this._capturePlotView(plot);
            const restoreView = options.liveAppend
                ? this._liveAppendRestoreView(plot, fileId, captured, previousData, newData)
                : captured;
            this._rebuildPanel(panelId, { restoreView });
        }
    }

    setFileTransform(fileId, transform) {
        const entry = this.files.get(fileId);
        if (!entry) return;
        const previousTransform = this._normalizeFileTransform(entry.transform);
        const previousTimeMode = this._timeDisplayMode(fileId);
        const pendingViews = new Map();
        for (const [panelId, plot] of this.plots) {
            const uses = plot.traces.some(t => t.fileId === fileId) ||
                         plot.phaseTraces.some(t => t.fileId === fileId) ||
                         plot.stateSlots?.fileId === fileId;
            if (uses) pendingViews.set(panelId, this._capturePlotView(plot));
        }
        entry.transform = this._normalizeFileTransform(transform);
        const nextTransform = entry.transform;
        const nextTimeMode = this._timeDisplayMode(fileId);
        entry._transformCache = null;
        for (const [panelId, plot] of this.plots) {
            const uses = plot.traces.some(t => t.fileId === fileId) ||
                         plot.phaseTraces.some(t => t.fileId === fileId) ||
                         plot.stateSlots?.fileId === fileId;
            if (!uses) continue;
            const restoreView = pendingViews.get(panelId);
            if (restoreView?.mode === '2d' && plot.mode === 'timeseries' && this._primaryTimeFileId(plot) === fileId) {
                restoreView.xRange = this._mapTimeRangeBetweenModes(fileId, restoreView.xRange, previousTimeMode, nextTimeMode, previousTransform, nextTransform);
            }
            this._rebuildPanel(panelId, { restoreView });
        }
    }

    getFileTransform(fileId) {
        return this._normalizeFileTransform(this.files.get(fileId)?.transform);
    }

    setExampleLayout(fileId, { tlId, trId, blId, brId }) {
        const c = this._nextColor.bind(this);

        // Top-left: timeseries theta + omega
        const tl = this.plots.get(tlId);
        if (tl) {
            tl.mode = 'timeseries';
            tl.traces = [
                { varName: 'theta', color: c(0), fileId },
                { varName: 'omega', color: c(1), fileId },
            ];
            this._rebuildPanel(tlId);
        }

        // Bottom-left: timeseries Ekin + Epot + Etot
        const bl = this.plots.get(blId);
        if (bl) {
            bl.mode = 'timeseries';
            bl.traces = [
                { varName: 'Ekin', color: c(0), fileId },
                { varName: 'Epot', color: c(1), fileId },
                { varName: 'Etot', color: c(2), fileId },
            ];
            this._rebuildPanel(blId);
        }

        // Top-right: phase2dt x vs y
        const tr = this.plots.get(trId);
        if (tr) {
            tr.mode = 'phase2dt';
            tr.phaseTraces = [{ x: 'x', y: 'y', z: null, color: c(0), fileId }];
            const trEl = document.querySelector(`.layout-panel[data-id="${trId}"]`);
            if (trEl) this._injectModeButtons(trId, trEl, 'phase2dt');
            this._rebuildPanel(trId);
        }

        // Bottom-right: phase2d theta vs omega
        const br = this.plots.get(brId);
        if (br) {
            br.mode = 'phase2d';
            br.phaseTraces = [{ x: 'theta', y: 'omega', z: null, color: c(0), fileId }];
            const brEl = document.querySelector(`.layout-panel[data-id="${brId}"]`);
            if (brEl) this._injectModeButtons(brId, brEl, 'phase2d');
            this._rebuildPanel(brId);
        }
    }

    setLorenzExampleLayout(fileId, { panelId, brId, tlId }) {
        const id = panelId || brId || tlId;
        const plot = this.plots.get(id);
        if (!plot) return;

        plot.mode = 'state-anim';
        plot.stateAnimDim = 3;
        plot.projection = 'orthographic';
        plot.animSpeed = 0.25;
        plot.autoPlayOnRender = true;
        plot.showCameraOverlay = false;
        plot.homeCamera = {
            eye: { x: 2.7443, y: -1.2215, z: 1.5367 },
            up: { x: 0, y: 0, z: 1 },
            center: { x: 0.147, y: 0.2334, z: -0.1396 },
        };
        plot.stateSlots = { x: ['x', 'y', 'z'], dx: ['der(x)', 'der(y)', 'der(z)'], fileId };
        plot.stateConfig = {
            showFullTrace: true,
            showTrace: true,
            showArrowX: true,
            showArrowDx: true,
            normalizeDx: true,
            dynamicZoom: false,
        };

        const panelEl = document.querySelector(`.layout-panel[data-id="${id}"]`);
        if (panelEl) this._injectModeButtons(id, panelEl, 'state-anim');
        this._rebuildPanel(id);
    }

    hasAnyTraces() {
        for (const [, plot] of this.plots) {
            if (this._hasContent(plot)) return true;
        }
        return false;
    }

    /** Like _setMode but returns a Promise so callers can await mode change. */
    setModeAsync(panelId, mode) {
        this._setMode(panelId, mode);
        return Promise.resolve();
    }

    hasTracesForFile(fileId) {
        for (const [, plot] of this.plots) {
            if (plot.traces.some(t => t.fileId === fileId)) return true;
            if (plot.phaseTraces.some(t => t.fileId === fileId)) return true;
        }
        return false;
    }

    setTheme(theme)            { this.theme = theme;          this._relayoutAll(); }
    setLanguage(language)      { this.language = normalizeAppLanguage(language); }
    preserveViewsForNextRender() {
        for (const [, plot] of this.plots) {
            const view = this._capturePlotView(plot, { manualRangesOnly: true });
            if (view) plot._pendingViewRestore = view;
        }
    }
    setSyncAxes(v)             { this.syncAxes = v; }
    setLegendPosition(pos) {
        this.legendPosition = ['overlay', 'above', 'right', 'hidden'].includes(pos) ? pos : 'overlay';
        this._relayoutLegendAll();
    }
    setLegendOverlayCorner(corner) {
        if (!['tl', 'tr', 'bl', 'br'].includes(corner)) return;
        this.legendOverlayCorner = corner;
        if (this.legendPosition === 'overlay') this._relayoutLegendAll();
    }
    setTimeseriesDownsamplingLimit(limit) {
        this.timeseriesVisualMaxPoints = this._normalizeTimeseriesDownsamplingLimit(limit);
        this._refreshAllTimeseriesVisuals();
    }
    setPhaseDownsamplingLimit(limit) {
        this.phaseVisualMaxPoints = this._normalizePhaseDownsamplingLimit(limit);
        this._refreshAllPhaseVisuals();
    }
    setRelayoutRefreshMode(mode) {
        this.relayoutRefreshMode = ['auto', 'smooth', 'responsive'].includes(mode) ? mode : 'auto';
    }
    setSyncHover(v) {
        this.syncHover = v;
        document.body.classList.toggle('sync-hover-active', v);
        if (!v) this._clearHoverMarkers({ deferPlotly: true });
    }
    setHoverInfoCorner(corner) {
        if (!['tl', 'tr', 'bl', 'br'].includes(corner)) return;
        this.hoverInfoCorner = corner;
        for (const [, plot] of this.plots) {
            const panelEl = plot?.div?.closest('.layout-panel');
            const box = panelEl?.querySelector('.hover-info-box');
            if (box) this._applyHoverInfoBoxPosition(box);
        }
    }
    setHoverProximity(v) {
        const next = !!v;
        if (this.hoverProximity === next) return;
        this.hoverProximity = next;
        const hovermode = next ? 'closest' : 'x';
        for (const [, plot] of this.plots) {
            if (plot?.div && (plot.mode === 'timeseries' || plot.mode === 'fft')) {
                Plotly.relayout(plot.div, { hovermode });
            }
        }
    }
    setMouseWheelZoom(v) {
        const next = !!v;
        if (this.mouseWheelZoom === next) return;
        this.mouseWheelZoom = next;
        for (const [, plot] of this.plots) {
            this._applyMouseWheelZoomConfig(plot?.div, next);
            this._applyMouseWheelZoomConfig(plot?.fftDiv, next);
            this._applyMouseWheelZoomConfig(plot?.histogramDiv, next);
            this._applyMouseWheelZoomConfig(plot?.heatmapDiv, next);
        }
    }

    _getPlotlyConfig(overrides = {}) {
        return {
            responsive: true,
            displayModeBar: true,
            displaylogo: false,
            scrollZoom: this.mouseWheelZoom,
            locale: getPlotlyLocale(this.language),
            ...overrides,
        };
    }

    _applyMouseWheelZoomConfig(div, enabled = this.mouseWheelZoom) {
        if (!div?._context) return;
        const value = enabled ? 1 : 0;
        div._context.scrollZoom = !!enabled;
        div._context._scrollZoom = {
            ...(div._context._scrollZoom || {}),
            cartesian: value,
            gl3d: value,
            geo: value,
            mapbox: value,
            map: value,
        };
        if (div._fullLayout) {
            div._fullLayout._enablescrollzoom = !!enabled;
            for (const key of Object.keys(div._fullLayout)) {
                const scene = div._fullLayout[key];
                if (key.startsWith('scene') && scene?._scene?.camera) {
                    scene._scene.camera.enableWheel = !!enabled;
                }
            }
        }
    }

    resizeAll() {
        for (const [, plot] of this.plots) {
            if (!plot.div) continue;
            Promise.resolve(Plotly.Plots.resize(plot.div)).then(() => {
                this._refreshPanelDomOverlays(plot);
            });
            if (plot.fftDiv) Plotly.Plots.resize(plot.fftDiv);
            if (plot.histogramDiv) Plotly.Plots.resize(plot.histogramDiv);
            if (plot.heatmapDiv) Plotly.Plots.resize(plot.heatmapDiv);
        }
    }

    _refreshPanelDomOverlays(plot) {
        if (!plot?.div || !plot.div.isConnected) return;
        if (this._plotSupportsCursors?.(plot) && plot.cursors?.enabled && typeof this._renderCursorOverlay === 'function') {
            this._renderCursorOverlay(plot);
        }
        if (this.syncHover && typeof this._hideHoverOverlay === 'function') {
            this._hideHoverOverlay(plot);
        }
    }

    autoZoomAll() {
        for (const [id, plot] of this.plots) {
            if (!plot.div) continue;
            this._autoScalePlot(id, plot);
        }
    }

    clearAll() {
        for (const [id] of this.plots) this._clearPanel(id);
    }

    // ─── Panel lifecycle ───────────────────────────────────────────

    _mountPanel(panelId, panelEl) {
        // Ensure state exists (may already exist after a re-render)
        if (!this.plots.has(panelId)) {
            this.plots.set(panelId, this._makeState());
        }
        const plot = this.plots.get(panelId);

        // Inject mode buttons into the panel toolbar
        this._injectModeButtons(panelId, panelEl, plot.mode);

        // Set up drop handlers
        this._bindDropHandlers(panelId, panelEl);

        // Re-create chart if this panel already had data (after language/layout re-render)
        if (this._hasContent(plot)) {
            if (plot.mode === 'state-anim') {
                this._createStateAnimChart(panelId, panelEl);
            } else {
                this._createChart(panelId, panelEl);
            }
        } else {
            this._updatePlaceholder(panelId, panelEl);
        }
    }

    _unmountPanel(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        this._destroyChart(panelId);
        this.plots.delete(panelId);  // panel is gone from DOM — remove completely
    }

    // ─── Mode switching ────────────────────────────────────────────

    _setMode(panelId, mode, stateAnimDim = null, options = {}) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const previousMode = plot.mode;
        const nextDim = mode === 'state-anim' ? (stateAnimDim || plot.stateAnimDim || 2) : plot.stateAnimDim;
        if (plot.mode === mode && plot.stateAnimDim === nextDim) return;
        this._dismissModeChangeWarning?.(panelId);
        const timeTraceModes = new Set(['timeseries', 'fft', 'histogram', 'heatmap']);
        const preserveTimeTraces = !!options.preserveTimeTraces
            && timeTraceModes.has(previousMode)
            && timeTraceModes.has(mode);
        const preservedTraces = preserveTimeTraces
            ? plot.traces.map(trace => ({ ...trace, axis: 'y' }))
            : [];
        // phase2d and correlation share the pair list; preserve pairs (and the
        // correlation window) when toggling between them so the user keeps them.
        const phasePairModes = new Set(['phase2d', 'correlation']);
        const preservePhasePairs = phasePairModes.has(previousMode) && phasePairModes.has(mode);
        const preservedPhaseTraces = preservePhasePairs ? plot.phaseTraces.map(t => ({ ...t })) : [];
        const preservedPhasePending = preservePhasePairs
            ? { ...plot.phasePending }
            : { x: null, y: null, z: null, fileId: null };
        const restoreView = preserveTimeTraces ? this._capturePlotView(plot) : null;

        // Stop animation if running
        this._stopAnim(plot);

        // Tear down existing chart
        this._destroyChart(panelId);
        plot.mode         = mode;
        plot.stateAnimDim = nextDim;
        plot.traces       = preservedTraces;
        plot.phaseTraces  = preservedPhaseTraces;
        plot.phasePending = preservedPhasePending;
        plot.stateSlots   = { x: [], dx: [], fileId: null };
        plot.equalAspect2D = false;
        plot.timeseriesStacked = false;
        plot.timeseriesY2Enabled = false;
        plot.showMissingData = false;
        plot.traces.forEach(trace => { trace.axis = 'y'; });
        // Preserve per-mode config (FFT, histogram and calendar heatmap options,
        // selection, cursors) when switching inside the time-series family, so
        // the user can move between those modes without losing settings.
        // A hard change to a phase/state mode still starts each config fresh.
        if (preserveTimeTraces) {
            plot.fft = plot.fft || this._defaultFftState?.();
            plot.histogram = plot.histogram || this._defaultHistogramState?.();
            plot.heatmap = plot.heatmap || this._defaultHeatmapState?.();
        } else {
            plot.cursors = this._defaultCursors();
            plot.cursorsSpectrum = this._defaultCursors();
            plot.fft = this._defaultFftState?.() || plot.fft;
            plot.histogram = this._defaultHistogramState?.() || plot.histogram;
            plot.heatmap = this._defaultHeatmapState?.() || plot.heatmap;
        }
        plot.correlation = preservePhasePairs
            ? (plot.correlation || this._defaultCorrelationState?.())
            : (this._defaultCorrelationState?.() || plot.correlation);
        plot.liveView = this._defaultLiveViewPolicy(mode);
        plot.animFrame    = 0;

        // Update UI — re-inject all buttons so view labels reflect the new mode
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!panelEl) return;
        const placeholder = panelEl.querySelector('.layout-panel-placeholder');
        if (placeholder) { placeholder.style.display = ''; placeholder.classList.remove('drag-over'); }
        this._injectModeButtons(panelId, panelEl, mode);
        if (restoreView) plot._pendingViewRestore = restoreView;
        if (this._hasContent(plot)) {
            if (placeholder) placeholder.style.display = 'none';
            if (mode === 'state-anim') this._createStateAnimChart(panelId, panelEl);
            else this._createChart(panelId, panelEl);
        } else {
            this._updatePlaceholder(panelId, panelEl);
        }
    }

    // ─── Drop handling ─────────────────────────────────────────────

    _bindDropHandlers(panelId, panelEl) {
        if (panelEl._dropBound) return;
        panelEl._dropBound = true;

        // Create a persistent overlay that sits on top of the plot during drag
        const overlay = document.createElement('div');
        overlay.className = 'drop-overlay';
        panelEl.appendChild(overlay);

        const getPlaceholder = () => panelEl.querySelector('.layout-panel-placeholder');
        const hasChart = () => { const p = this.plots.get(panelId); return !!(p && p.div); };

        const showDragHint = (event = null) => {
            const axis = this._timeseriesDropAxis(panelId, panelEl, event);
            const msg = this._dropMessage(panelId, axis);
            const plot = this.plots.get(panelId);
            const y2Drop = !!(plot?.mode === 'timeseries' && plot.timeseriesY2Enabled);
            if (hasChart()) {
                // Existing plot: show transparent overlay on top
                overlay.innerHTML = `<span>${msg}</span>`;
                overlay.classList.add('active');
                overlay.classList.toggle('timeseries-y2-drop', y2Drop);
                overlay.classList.toggle('axis-left', y2Drop && axis !== 'y2');
                overlay.classList.toggle('axis-right', y2Drop && axis === 'y2');
            } else {
                overlay.classList.remove('timeseries-y2-drop', 'axis-left', 'axis-right');
                // Empty panel: update the placeholder text in-place (no position shift)
                const ph = getPlaceholder();
                if (ph) {
                    ph.dataset.savedHtml = ph.innerHTML;
                    ph.innerHTML = `<span>${msg}</span>`;
                    ph.classList.add('drag-over');
                }
            }
        };

        const hideDragHint = () => {
            // If a pending trace is in progress AND a chart already exists, keep overlay visible
            const p = this.plots.get(panelId);
            const hasPending = p && p.div && p.mode !== 'timeseries' && p.phasePending && p.phasePending.x;
            if (hasPending) {
                overlay.classList.add('active', 'pending');
                overlay.innerHTML = `<span>${this._dropMessage(panelId)}</span>`;
            } else {
                overlay.classList.remove('active', 'pending');
            }
            overlay.classList.remove('timeseries-y2-drop', 'axis-left', 'axis-right');
            const ph = getPlaceholder();
            if (ph) {
                ph.classList.remove('drag-over');
                if (ph.dataset.savedHtml !== undefined) {
                    ph.innerHTML = ph.dataset.savedHtml;
                    delete ph.dataset.savedHtml;
                }
            }
        };

        panelEl.addEventListener('dragover', (e) => {
            if (!this.data) return;
            e.preventDefault();
            showDragHint(e);
        });

        panelEl.addEventListener('dragleave', (e) => {
            if (panelEl.contains(e.relatedTarget)) return;
            hideDragHint();
        });

        panelEl.addEventListener('drop', (e) => {
            e.preventDefault();
            hideDragHint();
            const varNames = this._getDroppedVariableNames(e.dataTransfer);
            if (!varNames.length || !this.data) return;
            const axis = this._timeseriesDropAxis(panelId, panelEl, e);
            if (varNames.length > 1) {
                this._addDroppedVariables(panelId, varNames, panelEl, { axis });
            } else {
                this.addTrace(panelId, varNames[0], panelEl, { axis });
            }
        });
    }

    _timeseriesDropAxis(panelId, panelEl, event = null) {
        const plot = this.plots.get(panelId);
        if (!plot?.timeseriesY2Enabled || plot.mode !== 'timeseries' || !event) return 'y';
        const rect = panelEl.getBoundingClientRect?.();
        if (!rect?.width) return 'y';
        return event.clientX >= rect.left + rect.width / 2 ? 'y2' : 'y';
    }

    _getDroppedVariableNames(dataTransfer) {
        const raw = dataTransfer.getData('application/x-openmodelica-variables');
        if (raw) {
            try {
                const payload = JSON.parse(raw);
                if (payload?.type === 'variables' && Array.isArray(payload.names)) {
                    return payload.names.filter(Boolean);
                }
            } catch (_) {}
        }
        const varName = dataTransfer.getData('text/plain');
        return varName ? [varName] : [];
    }

    _addDroppedVariables(panelId, varNames, panelEl, options = {}) {
        if (!this.plots.has(panelId)) this.plots.set(panelId, this._makeState());
        const plot = this.plots.get(panelId);
        const names = varNames.filter(varName => {
            const variable = this.data?.variables?.[varName];
            return variable && variable.plottable !== false && variable.kind !== 'abscissa' && variable.dataType !== 'string';
        });
        if (!names.length) return;

        if (plot.mode === 'timeseries') {
            names.forEach(varName => this.addTrace(panelId, varName, panelEl, { axis: options.axis || 'y' }));
            return;
        }

        if (plot.mode === 'fft') {
            names.forEach(varName => this.addTrace(panelId, varName, panelEl));
            return;
        }

        if (plot.mode === 'histogram') {
            names.forEach(varName => this.addTrace(panelId, varName, panelEl));
            return;
        }

        if (plot.mode === 'heatmap') {
            names.forEach(varName => this.addTrace(panelId, varName, panelEl));
            return;
        }

        if (plot.mode === 'phase2d' || plot.mode === 'phase2dt' || plot.mode === 'phase3d') {
            const groupSize = plot.mode === 'phase3d' ? 3 : 2;
            if (!this._canAddTraceWithFileTime(plot, this.activeFileId)) return;
            plot.phasePending = { x: null, y: null, z: null, fileId: null };
            let added = 0;
            for (let i = 0; i + groupSize - 1 < names.length; i += groupSize) {
                plot.phaseTraces.push({
                    x: names[i],
                    y: names[i + 1],
                    z: groupSize === 3 ? names[i + 2] : null,
                    color: this._nextTraceColor(plot.phaseTraces),
                    fileId: this.activeFileId,
                });
                added += 1;
            }
            if (added > 0) {
                if (!plot.div) this._createChart(panelId, panelEl);
                else this._updatePhaseChart(panelId, plot);
                this._setPendingOverlay(panelId, panelEl, false);
            } else {
                this._updatePlaceholder(panelId, panelEl);
            }
            return;
        }

        if (plot.mode === 'state-anim') {
            const dim = plot.stateAnimDim || 2;
            if (plot.div) this._destroyChart(panelId);
            plot.stateSlots = { x: names.slice(0, dim), dx: [], fileId: this.activeFileId };
            const data = this.files.get(this.activeFileId)?.data;
            if (data) {
                plot.stateSlots.dx = plot.stateSlots.x.map(name => this.parser.findDerivative(name, data.variables));
            }
            if (plot.stateSlots.x.length >= dim) {
                this._createStateAnimChart(panelId, panelEl);
            } else {
                const placeholder = panelEl.querySelector('.layout-panel-placeholder');
                if (placeholder) placeholder.style.display = '';
                this._updatePlaceholder(panelId, panelEl);
            }
            return;
        }

        this.addTrace(panelId, names[0], panelEl);
    }

    /** Show or hide a persistent "waiting for next variable" overlay on top of an existing chart. */
    _setPendingOverlay(panelId, panelEl, show) {
        const overlay = panelEl.querySelector('.drop-overlay');
        if (!overlay) return;
        if (show) {
            overlay.innerHTML = `<span>${this._dropMessage(panelId)}</span>`;
            overlay.classList.add('active', 'pending');
        } else {
            overlay.classList.remove('active', 'pending');
        }
    }

    /** Message shown in the drop overlay depending on mode and current state. */
    _dropMessage(panelId, axis = null) {
        const plot = this.plots.get(panelId);
        if (!plot) return i18n.t('dropVariableHere');

        const pp   = plot.phasePending;
        const mode = plot.mode;
        const n    = plot.phaseTraces.length; // completed traces

        // Timeseries: always accept more variables
        if (mode === 'timeseries') {
            if (plot.timeseriesY2Enabled) {
                return axis === 'y2' ? i18n.t('timeseriesDropRightAxis') : i18n.t('timeseriesDropLeftAxis');
            }
            return plot.traces.length === 0
                ? i18n.t('dropTimeseriesMulti')
                : i18n.t('dropToAddTrace');
        }

        if (mode === 'fft') {
            return plot.traces.length === 0
                ? i18n.t('dropFftMulti')
                : i18n.t('dropToAddTrace');
        }

        if (mode === 'histogram') {
            return plot.traces.length === 0
                ? i18n.t('dropHistogramMulti')
                : i18n.t('dropToAddTrace');
        }

        if (mode === 'heatmap') {
            return plot.traces.length === 0
                ? i18n.t('dropHeatmapMulti')
                : i18n.t('dropToAddTrace');
        }

        // State-anim mode
        if (mode === 'state-anim') {
            const sx = plot.stateSlots?.x || [];
            const dim = plot.stateAnimDim || 2;
            if (sx.length === 0) return dim === 3 ? i18n.t('dropState3dMulti') : i18n.t('dropState2dMulti');
            if (sx.length === 1) return i18n.t('dropStateX2');
            return dim === 3 ? i18n.t('dropStateX3') : i18n.t('dropVariableHere');
        }

        if (mode === 'correlation') {
            return !pp.x ? i18n.t('correlationDropX') : i18n.t('correlationDropY');
        }

        // Phase modes: guide axis by axis
        switch (mode) {
            case 'phase2d':
                return !pp.x ? i18n.t('dropPhase2dMulti') : i18n.t('dropY');
            case 'phase2dt':
                return !pp.x ? i18n.t('dropPhase2dtMulti') : i18n.t('dropYAutoTime');
            case 'phase3d':
                return !pp.x ? i18n.t('dropPhase3dMulti')
                     : !pp.y ? i18n.t('dropY')
                     :         i18n.t('dropZ');
        }
        return i18n.t('dropVariableHere');
    }

    // ─── Adding variables ──────────────────────────────────────────

    addTrace(panelId, varName, panelEl, options = {}) {
        if (!this.data) return;
        const variable = this.data.variables[varName];
        if (!variable || variable.plottable === false || variable.kind === 'abscissa' || variable.dataType === 'string') return;

        if (!this.plots.has(panelId)) {
            this.plots.set(panelId, this._makeState());
        }
        const plot = this.plots.get(panelId);

        if (plot.mode === 'timeseries') {
            this._addTimeseries(panelId, varName, panelEl, plot, options);
        } else if (plot.mode === 'fft') {
            this._addFftTrace(panelId, varName, panelEl, plot);
        } else if (plot.mode === 'histogram') {
            this._addHistogramTrace(panelId, varName, panelEl, plot);
        } else if (plot.mode === 'heatmap') {
            this._addHeatmapTrace(panelId, varName, panelEl, plot);
        } else if (plot.mode === 'state-anim') {
            this._addStateAnimVar(panelId, varName, panelEl, plot);
        } else {
            this._addPhaseVar(panelId, varName, panelEl, plot);
        }
    }

    removeTrace(panelId, varName) {
        const plot = this.plots.get(panelId);
        if (!plot || !plot.div || plot.mode !== 'timeseries') return;
        const idx = plot.traces.findIndex(t => t.varName === varName);
        if (idx === -1) return;
        plot.traces.splice(idx, 1);
        const markerWasAfterTrace = Number.isInteger(plot.markerTraceIdx) && idx < plot.markerTraceIdx;
        Plotly.deleteTraces(plot.div, idx).then(() => {
            if (markerWasAfterTrace) plot.markerTraceIdx -= 1;
            this._syncTimeseriesMarkerColors(plot);
            if (plot.traces.length === 0) this._clearPanel(panelId);
            else this._syncCursorDisplay(panelId, plot);
        });
    }

    _addTimeseries(panelId, varName, panelEl, plot, options = {}) {
        if (plot.traces.find(t => t.varName === varName && t.fileId === this.activeFileId)) return; // deduplicate
        if (!this._canAddTraceWithFileTime(plot, this.activeFileId)) return;
        const axis = plot.timeseriesY2Enabled && options.axis === 'y2' ? 'y2' : 'y';
        plot.traces.push({ varName, color: this._nextTraceColor(plot.traces), fileId: this.activeFileId, axis });

        if (!plot.div) {
            this._createChart(panelId, panelEl);
        } else {
            const t = plot.traces[plot.traces.length - 1];
            const insertIndex = Number.isInteger(plot.markerTraceIdx) ? plot.markerTraceIdx : undefined;
            const traceIndex = plot.traces.length - 1;
            const currentRange = plot.div._fullLayout?.xaxis?.range || plot.div.layout?.xaxis?.range || null;
            const builtTrace = this._buildTimeTrace(t, currentRange, plot, traceIndex);
            const addTracePromise = insertIndex === undefined
                ? Plotly.addTraces(plot.div, builtTrace)
                : Plotly.addTraces(plot.div, builtTrace, insertIndex);
            addTracePromise.then(() => {
                if (insertIndex !== undefined) plot.markerTraceIdx += 1;
                this._syncTimeseriesMarkerColors(plot);
                this._installLegendHoverHint(plot.div);
            });
            // Update Y axis title: clear when 2+ traces (X/time label always stays)
            const layout = this._buildTimeLayout(plot);
            const relayout = { 'yaxis.title': layout.yaxis.title, margin: layout.margin };
            if (layout.yaxis2) relayout.yaxis2 = layout.yaxis2;
            Plotly.relayout(plot.div, relayout);
            this._syncCursorDisplay(panelId, plot);
        }
    }

    _addPhaseVar(panelId, varName, panelEl, plot) {
        const pp   = plot.phasePending;
        const mode = plot.mode;

        // Fill the next empty slot in the pending trace
        if (!pp.x)                         { pp.x = varName; pp.fileId = this.activeFileId; }
        else if (!pp.y)                    { pp.y = varName; }
        else if (mode === 'phase3d' && !pp.z) { pp.z = varName; }
        else {
            // All slots full for this trace → start a new one
            pp.x = varName; pp.fileId = this.activeFileId;
            pp.y = null;
            pp.z = null;
        }

        const ready = (mode === 'phase2d'  && pp.x && pp.y)          ||
                      (mode === 'phase2dt' && pp.x && pp.y)          ||
                      (mode === 'correlation' && pp.x && pp.y)       ||
                      (mode === 'phase3d'  && pp.x && pp.y && pp.z);

        if (ready) {
            // Commit pending → completed trace
            if (!this._canAddTraceWithFileTime(plot, pp.fileId)) {
                plot.phasePending = { x: null, y: null, z: null, fileId: null };
                this._setPendingOverlay(panelId, panelEl, false);
                return;
            }
            const color = this._nextTraceColor(plot.phaseTraces);
            plot.phaseTraces.push({ x: pp.x, y: pp.y, z: pp.z || null, color, fileId: pp.fileId });
            plot.phasePending = { x: null, y: null, z: null, fileId: null };

            if (!plot.div) this._createChart(panelId, panelEl);
            else if (mode === 'correlation') this._updateCorrelationChart(panelId, plot);
            else           this._updatePhaseChart(panelId, plot);
            this._setPendingOverlay(panelId, panelEl, false);
        } else {
            this._updatePlaceholder(panelId, panelEl);
            // Only show overlay hint when a chart already exists (placeholder handles the empty case)
            if (plot.div) this._setPendingOverlay(panelId, panelEl, true);
        }
    }

    // ─── Chart creation ────────────────────────────────────────────

    _createChart(panelId, panelEl) {
        const plot = this.plots.get(panelId);
        if (!this._hasContent(plot)) return;
        if (plot.mode === 'fft') {
            this._createFftChart(panelId, panelEl);
            return;
        }
        if (plot.mode === 'histogram') {
            this._createHistogramChart(panelId, panelEl);
            return;
        }
        if (plot.mode === 'heatmap') {
            this._createHeatmapChart(panelId, panelEl);
            return;
        }
        if (plot.mode === 'correlation') {
            this._createCorrelationChart(panelId, panelEl);
            return;
        }
        const restoreView = plot._pendingViewRestore || null;
        delete plot._pendingViewRestore;

        const placeholder = panelEl.querySelector('.layout-panel-placeholder');
        if (placeholder) placeholder.style.display = 'none';

        const div = document.createElement('div');
        div.className = `plotly-container plotly-mode-${plot.mode}`;
        panelEl.appendChild(div);
        plot.div = div;

        const { traces, layout } = this._buildPlotData(plot);
        const config = this._getPlotlyConfig();

        Plotly.newPlot(div, traces, layout, config).then(() => {
            this._refreshActionBtns(panelId);
            const finish3DSetup = () => {
                if (!this._is3D(plot.mode)) return;
                this._add3DAxisDecorations(plot);
            };
            const viewPromise = restoreView
                ? this._restorePlotView(plot, restoreView)
                : (this._is3D(plot.mode) ? this._setCamera(panelId, 'home') : Promise.resolve());
            Promise.resolve(viewPromise).then(() => {
                if (plot.mode === 'timeseries') this._refreshTimeseriesVisuals(panelId, plot);
                else if (plot.mode === 'phase2d' || plot.mode === 'phase2dt' || plot.mode === 'phase3d') {
                    this._refreshPhaseVisualsLazy?.(panelId, plot);
                }
                finish3DSetup();
            });
            div.on('plotly_doubleclick', () => {
                this._autoScalePlot(panelId, plot);
                return false;
            });
            // Axis sync, hover sync, and scroll-wheel pan (timeseries only)
            if (plot.mode === 'timeseries') {
                div.on('plotly_relayouting', (ed) => this._onRelayouting(panelId, ed));
                div.on('plotly_relayout', (ed) => this._onRelayout(panelId, ed));
                div.on('plotly_hover',    (ed) => this._onHover(panelId, ed));
                div.on('plotly_unhover',  ()   => this._onUnhover(panelId));
            } else if (plot.mode === 'phase2d') {
                div.on('plotly_relayout', (ed) => {
                    if (ed?.['xaxis.autorange'] === true || ed?.['yaxis.autorange'] === true) {
                        this._autoScalePlot(panelId, plot);
                    }
                });
            }
            // Pan gestures for 2D plots:
            //   Middle-click: toggle Plotly's native pan dragmode (works with button 1).
            //   Right-click:  custom pan — Plotly's drag only reacts to button 0, so we
            //                 manipulate axis ranges directly on mousemove.
            if (plot.mode === 'timeseries' || plot.mode === 'phase2d') {
                div.addEventListener('mousedown', (e) => {
                    if (e.button === 0
                        && plot.mode === 'timeseries'
                        && div?._fullLayout?.dragmode !== 'pan'
                        && this._eventInsidePlotArea(div, e)) {
                        this._beginCursorBoxZoomSuppress(panelId, plot);
                    }
                    if (e.button === 1) {
                        e.preventDefault();
                        Plotly.relayout(div, { dragmode: 'pan' });
                        document.addEventListener('mouseup', () => {
                            Plotly.relayout(div, { dragmode: 'zoom' });
                        }, { once: true });
                        return;
                    }
                    if (e.button !== 2) return;
                    const fl = div._fullLayout;
                    const xa = fl?.xaxis, ya = fl?.yaxis;
                    if (!xa || !ya || !xa._length || !ya._length) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const startX = e.clientX, startY = e.clientY;
                    const x0 = xa.range.slice(), y0 = ya.range.slice();
                    const y2a = plot.timeseriesY2Enabled ? fl?.yaxis2 : null;
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
                        if (plot.mode === 'timeseries' && this._canLiveRefreshTimeseriesRelayout(plot, latestXRange)) {
                            this._scheduleLiveRelayoutingRefresh(panelId, plot, latestXRange, { allowRelayoutLiveOnly: true });
                        }
                        Plotly.relayout(div, update).finally(() => {
                            if (plot._relayoutLiveOnly) this._renderCursorOverlay(plot, { range: latestXRange, lightweight: true });
                        });
                    };
                    const onUp = () => {
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        plot._relayoutLiveOnly = false;
                        this._onRelayout(panelId, { 'xaxis.range': latestXRange });
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                }, { capture: true });
                div.addEventListener('contextmenu', (e) => {
                    if (plot.mode === 'timeseries' && plot.timeseriesY2Enabled && this._handleTimeseriesLegendContextMenu(panelId, plot, e)) return;
                    e.preventDefault();
                });
                // Two-finger horizontal trackpad swipe pans; vertical keeps
                // Plotly's zoom.
                this._installWheelPan(panelId, plot, div, {
                    finalize: plot.mode === 'timeseries'
                        ? (xRange) => this._onRelayout(panelId, { 'xaxis.range': xRange })
                        : null,
                });
            }
            // Track legend visibility in our own state so it survives re-renders.
            // We match by trace name, not by curveNumber, because marker traces inserted via
            // Plotly.addTraces shift the indices and make curveNumber unreliable.
            const toggleVisByName = (clickedName) => {
                if (clickedName === '__hover__') return;
                if (plot.mode === 'timeseries') {
                    const t = plot.traces.find(t => this._traceName(t.varName, t.fileId) === clickedName);
                    if (t) t.visible = (t.visible === 'legendonly') ? true : 'legendonly';
                } else {
                    const t = plot.phaseTraces.find(pt => {
                        return this._phaseTraceName(plot, pt) === clickedName;
                    });
                    if (t) t.visible = (t.visible === 'legendonly') ? true : 'legendonly';
                }
            };
            const removeByLegendName = (clickedName) => {
                if (!clickedName || clickedName === '__hover__') return false;
                if (plot.mode === 'timeseries') {
                    const idx = plot.traces.findIndex(t => this._traceName(t.varName, t.fileId) === clickedName);
                    if (idx < 0) return false;
                    plot.traces.splice(idx, 1);
                } else {
                    const idx = plot.phaseTraces.findIndex(pt => this._phaseTraceName(plot, pt) === clickedName);
                    if (idx < 0) return false;
                    plot.phaseTraces.splice(idx, 1);
                }
                this._rebuildPanel(panelId);
                return true;
            };
            let lastMouseDownHadShift = false;
            div.addEventListener('mousedown', (e) => {
                lastMouseDownHadShift = !!e.shiftKey;
            }, { capture: true });
            div.on('plotly_legendclick', (ed) => {
                const clickedName = ed.data[ed.curveNumber]?.name;
                const shiftClick = !!(ed.event?.shiftKey || lastMouseDownHadShift);
                lastMouseDownHadShift = false;
                if (shiftClick) {
                    removeByLegendName(clickedName);
                    return false;
                }
                toggleVisByName(clickedName);
                setTimeout(() => this._syncCursorDisplay(panelId, plot), 0);
            });
            // Double-click isolates one trace (or restores all). Read _fullData after it settles.
            div.on('plotly_legenddoubleclick', () => {
                setTimeout(() => {
                    if (!plot.div || !plot.div._fullData) return;
                    const realTraces = plot.mode === 'timeseries' ? plot.traces : plot.phaseTraces;
                    plot.div._fullData.forEach(fd => {
                        if (fd.name === '__hover__') return;
                        const t = realTraces.find(rt =>
                            plot.mode === 'timeseries' ? rt.varName === fd.name : false
                        );
                        if (t) t.visible = fd.visible ?? true;
                    });
                }, 50);
            });
            div.on('plotly_afterplot', () => {
                this._installLegendHoverHint(div);
                this._refreshPanelDomOverlays(plot);
            });
            this._installLegendHoverHint(div);
            // Pre-allocate marker trace for hover sync on all modes
            this._initMarkerTrace(plot);
            this._installCursorHandlers(panelId, plot);
            this._syncCursorDisplay(panelId, plot);
            // Resize observer
            let timer;
            const ro = new ResizeObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    Promise.resolve(Plotly.Plots.resize(div)).then(() => {
                        requestAnimationFrame(() => this._refreshPanelDomOverlays(plot));
                    });
                }, 50);
            });
            ro.observe(panelEl);
            plot.resizeObserver = ro;
        });
    }

    _updatePhaseChart(panelId, plot) {
        if (!plot.div) return;
        // Add only the newest phase trace — never touches the camera/scene.
        // Note: _buildPhase2DTraces appends an __origin__ cross AFTER the phase traces,
        // so we index by phaseTraces.length-1 rather than allTraces.length-1.
        const allTraces = this._buildPlotData(plot).traces;
        const newTrace = allTraces[plot.phaseTraces.length - 1];
        Plotly.addTraces(plot.div, newTrace).then(() => {
            // Add a corresponding marker trace for hover sync
            const panelEl = plot.div.closest('.layout-panel');
            this._addOneMarkerTrace(plot, plot.phaseTraces[plot.phaseTraces.length - 1]);
            this._installLegendHoverHint(plot.div);
            this._refreshPhaseVisualsLazy?.(panelId, plot);
        });
        // Update legend and axis titles (no scene keys → no camera reset for 3D)
        const { bg, gridColor, legendBg } = this._colors();
        const relayoutUpdate = {
            showlegend: true,
            legend: this._legendConfig(legendBg, gridColor),
        };
        if (plot.mode === 'phase2d') {
            const layout = this._buildPhase2DLayout(plot);
            relayoutUpdate['xaxis.title'] = layout.xaxis.title;
            relayoutUpdate['yaxis.title'] = layout.yaxis.title;
        } else if (plot.mode === 'phase2dt' || plot.mode === 'phase3d') {
            const isTimez = plot.mode === 'phase2dt';
            const layout = this._buildPhase3DLayout(plot, isTimez);
            // Read current camera so relayout doesn't reset it
            const cam = plot.div._fullLayout?.scene?.camera;
            relayoutUpdate['scene.xaxis.title'] = layout.scene.xaxis.title;
            relayoutUpdate['scene.yaxis.title'] = layout.scene.yaxis.title;
            relayoutUpdate['scene.zaxis.title'] = layout.scene.zaxis.title;
            // Update axis ranges so added traces expand the box (autorange:false is used)
            relayoutUpdate['scene.xaxis.range'] = layout.scene.xaxis.range;
            relayoutUpdate['scene.yaxis.range'] = layout.scene.yaxis.range;
            relayoutUpdate['scene.zaxis.range'] = layout.scene.zaxis.range;
            if (isTimez) {
                Object.assign(relayoutUpdate, this._timeAxisRelayoutUpdate(layout.scene.xaxis, 'scene.xaxis'));
            }
            if (cam) relayoutUpdate['scene.camera'] = cam;
        }
        Plotly.relayout(plot.div, relayoutUpdate);
    }

    _installLegendHoverHint(div) {
        if (!div) return;
        requestAnimationFrame(() => {
            const items = div.querySelectorAll('.legend .traces');
            items.forEach(item => {
                let title = [...item.children].find(child => child.tagName?.toLowerCase() === 'title');
                if (!title) {
                    title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                    item.insertBefore(title, item.firstChild);
                }
                title.textContent = i18n.t('legendHint');
            });
        });
    }

    _handleTimeseriesLegendContextMenu(panelId, plot, event) {
        const item = event.target?.closest?.('.legend .traces');
        if (!item || !plot?.timeseriesY2Enabled) return false;
        const items = [...plot.div.querySelectorAll('.legend .traces')];
        const legendIndex = items.indexOf(item);
        if (legendIndex < 0) return false;
        const legendTraces = (plot.div._fullData || []).filter(fd => fd.showlegend !== false && fd.name !== '__hover__');
        const clickedName = legendTraces[legendIndex]?.name;
        const trace = plot.traces.find(t => this._traceName(t.varName, t.fileId) === clickedName);
        if (!trace) return false;
        event.preventDefault();
        event.stopPropagation();
        this._showTimeseriesAxisMenu(panelId, plot, trace, event);
        return true;
    }

    _showTimeseriesAxisMenu(panelId, plot, trace, event) {
        document.querySelector('.timeseries-axis-menu')?.remove();
        const menu = document.createElement('div');
        menu.className = 'timeseries-axis-menu';
        const moveRight = this._traceYAxis(trace, plot) !== 'y2';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = i18n.t(moveRight ? 'timeseriesY2MoveRight' : 'timeseriesY2MoveLeft');
        button.addEventListener('click', () => {
            trace.axis = moveRight ? 'y2' : 'y';
            menu.remove();
            this._rebuildPanel(panelId, { preserveView: true });
        });
        menu.appendChild(button);
        document.body.appendChild(menu);
        const x = Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8);
        const y = Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8);
        menu.style.left = `${Math.max(8, x)}px`;
        menu.style.top = `${Math.max(8, y)}px`;
        const close = (closeEvent) => {
            if (menu.contains(closeEvent.target)) return;
            menu.remove();
            document.removeEventListener('pointerdown', close, true);
        };
        setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
    }

    _destroyChart(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        if (typeof this._cleanupLazyDetailForPanel === 'function') {
            this._cleanupLazyDetailForPanel(panelId, plot);
        }
        this._abortFftWorkerJob?.(plot, 'FFT panel destroyed');
        this._stopAnim(plot);
        if (plot.resizeObserver) { plot.resizeObserver.disconnect(); plot.resizeObserver = null; }
        // Reset dynamic trace indices
        delete plot._arrowXIdx;
        delete plot._arrowDxIdx;
        delete plot._xAbsMax;
        delete plot._yAbsMax;
        if (plot._cursorDocListeners) {
            document.removeEventListener('mousemove', plot._cursorDocListeners.move);
            document.removeEventListener('mouseup',   plot._cursorDocListeners.up);
            plot._cursorDocListeners = null;
        }
        delete plot._cursorHandlersDiv;
        if (plot.div) {
            const correlationContainer = plot.div.closest('.correlation-container');
            const fftContainer = plot.div.closest('.fft-container');
            const histContainer = plot.div.closest('.hist-container');
            const heatmapContainer = plot.div.closest('.heatmap-container');
            if (correlationContainer) {
                // Checked before .fft-container: the shell reuses fft-* CSS but
                // carries a distinct correlation-container marker.
                if (plot.correlationDiv) Plotly.purge(plot.correlationDiv);
                Plotly.purge(plot.div);
                correlationContainer.remove();
                plot.div = null;
                plot.correlationDiv = null;
                plot.correlationContainer = null;
            } else if (heatmapContainer) {
                this._cleanupHeatmapChart?.(panelId, plot);
                if (plot.heatmapDiv) Plotly.purge(plot.heatmapDiv);
                Plotly.purge(plot.div);
                heatmapContainer.remove();
                plot.div = null;
                plot.heatmapDiv = null;
                plot.heatmapContainer = null;
            } else if (histContainer) {
                if (plot.histogramDiv) Plotly.purge(plot.histogramDiv);
                Plotly.purge(plot.div);
                histContainer.remove();
                plot.div = null;
                plot.histogramDiv = null;
                plot.histogramContainer = null;
            } else if (fftContainer) {
                if (plot.fftDiv) Plotly.purge(plot.fftDiv);
                Plotly.purge(plot.div);
                fftContainer.remove();
                plot.div = null;
                plot.fftDiv = null;
                plot.fftContainer = null;
            } else {
                // Remove state-anim container if present (wraps the plot div)
                const saContainer = plot.div.closest('.state-anim-container');
                if (saContainer) { Plotly.purge(plot.div); saContainer.remove(); }
                else { Plotly.purge(plot.div); plot.div.remove(); }
                plot.div = null;
            }
        }
        if (plot._fftSelectionDocListeners) {
            document.removeEventListener('mousemove', plot._fftSelectionDocListeners.move);
            document.removeEventListener('mouseup', plot._fftSelectionDocListeners.up);
            plot._fftSelectionDocListeners = null;
        }
        if (plot._fftSplitterDocListeners) {
            document.removeEventListener('mousemove', plot._fftSplitterDocListeners.move);
            document.removeEventListener('mouseup', plot._fftSplitterDocListeners.up);
            plot._fftSplitterDocListeners = null;
        }
        if (plot._fftHelpDocListeners) {
            document.removeEventListener('click', plot._fftHelpDocListeners.click, true);
            document.removeEventListener('keydown', plot._fftHelpDocListeners.key);
            plot._fftHelpDocListeners = null;
        }
        plot._fftHandlersInstalled = false;
        plot._fftSelectionDiv = null;
        if (plot._histSelectionDocListeners) {
            document.removeEventListener('mousemove', plot._histSelectionDocListeners.move);
            document.removeEventListener('mouseup', plot._histSelectionDocListeners.up);
            plot._histSelectionDocListeners = null;
        }
        if (plot._histSplitterDocListeners) {
            document.removeEventListener('mousemove', plot._histSplitterDocListeners.move);
            document.removeEventListener('mouseup', plot._histSplitterDocListeners.up);
            plot._histSplitterDocListeners = null;
        }
        clearTimeout(plot._histRecomputeTimer);
        plot._histHandlersInstalled = false;
        plot._histSelectionDiv = null;
        if (plot._correlationSelectionDocListeners) {
            document.removeEventListener('mousemove', plot._correlationSelectionDocListeners.move);
            document.removeEventListener('mouseup', plot._correlationSelectionDocListeners.up);
            plot._correlationSelectionDocListeners = null;
        }
        if (plot._correlationSplitterDocListeners) {
            document.removeEventListener('mousemove', plot._correlationSplitterDocListeners.move);
            document.removeEventListener('mouseup', plot._correlationSplitterDocListeners.up);
            plot._correlationSplitterDocListeners = null;
        }
        clearTimeout(plot._correlationRecomputeTimer);
        clearTimeout(plot._corrVisualTimer);
        plot._correlationSelectionDiv = null;
        this._cleanupHeatmapChart?.(panelId, plot);
        plot.cameraOverlayEl = null;
    }

    _clearPanel(panelId) {
        const existing = this.plots.get(panelId);
        this._dismissModeChangeWarning?.(panelId);
        if (typeof this._cleanupLazyDetailForPanel === 'function') {
            this._cleanupLazyDetailForPanel(panelId, existing);
        }
        if (existing) this._stopAnim(existing);
        this._destroyChart(panelId);

        // Reset state to empty (keep panel alive with fresh state)
        if (existing) {
            existing.traces        = [];
            existing.phaseTraces   = [];
            existing.phasePending  = { x: null, y: null, z: null };
            existing.markerTraceIdx = null;
            existing.timeseriesStacked = false;
            existing.timeseriesY2Enabled = false;
            existing.showMissingData = false;
            existing.fft = this._defaultFftState?.() || existing.fft;
            existing.heatmap = this._defaultHeatmapState?.() || existing.heatmap;
            existing.correlation = this._defaultCorrelationState?.() || existing.correlation;
            existing.stateSlots    = { x: [], dx: [], fileId: null };
            existing.equalAspect2D = false;
            existing.cursors = this._defaultCursors();
            existing.cursorsSpectrum = this._defaultCursors();
            existing.showCameraOverlay = false;
            existing.homeCamera = null;
            existing.animFrame     = 0;
            // keep existing.mode so the user's mode choice is preserved
        }

        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (panelEl) {
            const placeholder = panelEl.querySelector('.layout-panel-placeholder');
            if (placeholder) { placeholder.style.display = ''; placeholder.classList.remove('drag-over'); }
            this._setPendingOverlay(panelId, panelEl, false);
            this._hideCursorBox(panelEl);
            this._updatePlaceholder(panelId, panelEl);
        }
        this._refreshActionBtns(panelId);
    }

    _refreshActionBtns(panelId) {
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!panelEl) return;
        const plot = this.plots.get(panelId);
        const has = this._hasContent(plot);
        const isTimeseriesFamily = ['timeseries', 'fft', 'histogram', 'heatmap'].includes(plot?.mode);
        if (!isTimeseriesFamily) {
            panelEl.querySelector('.timeseries-tools-group')?.remove();
        }
        const csvBtn = panelEl.querySelector('.csv-export-btn');
        if (csvBtn) {
            // Aggregated Heatmap CSV belongs to the dedicated export phase;
            // never fall back to exporting a visually unrelated raw table.
            // Correlation CSV is a later phase; disable rather than export garbage.
            csvBtn.disabled = !has || plot?.mode === 'heatmap' || plot?.mode === 'correlation';
            if (plot?.mode === 'heatmap') csvBtn.title = i18n.t('heatmapExportPending');
        }
        const statsBtn = panelEl.querySelector('.panel-stats-btn');
        if (statsBtn) {
            statsBtn.disabled = !has || plot?.mode === 'heatmap' || plot?.mode === 'correlation';
            if (plot?.mode === 'heatmap') statsBtn.title = i18n.t('heatmapStatsPending');
        }
        const equalAspectBtn = panelEl.querySelector('.equal-aspect-btn');
        if (equalAspectBtn) {
            equalAspectBtn.classList.toggle('active', !!plot?.equalAspect2D);
            equalAspectBtn.setAttribute('aria-pressed', String(!!plot?.equalAspect2D));
        }
        const compareBtn = panelEl.querySelector('.compare-files-btn');
        if (compareBtn) {
            compareBtn.disabled = !(has && plot?.mode !== 'state-anim' && plot?.mode !== 'fft' && plot?.mode !== 'heatmap' && plot?.mode !== 'correlation' && this.files.size > 1);
        }
        const cursorBtn = panelEl.querySelector('.cursor-btn');
        if (cursorBtn) {
            const enabled = has && this._plotSupportsCursors?.(plot);
            cursorBtn.disabled = !enabled;
            cursorBtn.classList.toggle('active', !!plot?.cursors?.enabled);
        }
        const stackBtn = panelEl.querySelector('.timeseries-stack-btn');
        if (stackBtn) {
            const enabled = has && plot?.mode === 'timeseries';
            stackBtn.disabled = !enabled;
            stackBtn.classList.toggle('active', !!plot?.timeseriesStacked);
            stackBtn.setAttribute('aria-pressed', plot?.timeseriesStacked ? 'true' : 'false');
        }
        const y2Btn = panelEl.querySelector('.timeseries-y2-btn');
        if (y2Btn) {
            const enabled = has && plot?.mode === 'timeseries';
            y2Btn.disabled = !enabled;
            y2Btn.classList.toggle('active', !!plot?.timeseriesY2Enabled);
            y2Btn.setAttribute('aria-pressed', plot?.timeseriesY2Enabled ? 'true' : 'false');
        }
        const missingBtn = panelEl.querySelector('.timeseries-missing-btn');
        if (missingBtn) {
            const enabled = has && plot?.mode === 'timeseries';
            missingBtn.disabled = !enabled;
            missingBtn.classList.toggle('active', !!plot?.showMissingData);
            missingBtn.setAttribute('aria-pressed', plot?.showMissingData ? 'true' : 'false');
        }
        panelEl.querySelectorAll('.timeseries-analysis-btn').forEach(btn => {
            const active = btn.dataset.mode === plot?.mode;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', String(active));
        });
        panelEl.querySelectorAll('.panel-autoscale-btn').forEach(btn => {
            btn.disabled = !has;
        });
        // Show view-btn-group for 3D modes, state-anim (2D or 3D), and the
        // phase2d/correlation family (which hosts the Correlation toggle here).
        const isAnim = plot?.mode === 'state-anim' && has;
        const is3DMode = this._is3D(plot?.mode) || this._isStateAnim3D(plot);
        const isPhase2dFamilyMode = plot?.mode === 'phase2d' || plot?.mode === 'correlation';
        const showGroup = is3DMode || isAnim || this._supportsEqualAspect2D(plot) || isPhase2dFamilyMode;
        const viewGroup = panelEl.querySelector('.view-btn-group');
        if (viewGroup) {
            viewGroup.style.display = showGroup ? '' : 'none';
            // Hide plane/Iso buttons for 2D state-anim (only Home stays)
            viewGroup.querySelectorAll('.view-btn-3d-only').forEach(btn => {
                btn.style.display = is3DMode ? '' : 'none';
            });
        }
    }

    _exportCSV(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot || !this._hasContent(plot)) return;

        const headers = [];
        const columns = [];

        if (plot.mode === 'timeseries' || plot.mode === 'fft') {
            // Use first trace's file for the time column
            const firstFid = plot.traces[0]?.fileId;
            const timeVar  = this._getTimeVar(firstFid);
            const times    = firstFid ? this._getTransformedTimeData(firstFid) : [];
            const timeUnit = firstFid ? this._timeUnitLabel(firstFid) : (timeVar ? this._extractUnit(timeVar.description) : 's');
            headers.push(this._isCalendarTime(firstFid) ? 'time [datetime UTC]' : `time [${timeUnit}]`);
            columns.push(times.map(value => this._formatTimeForExport(firstFid, value)));
            for (const t of plot.traces) {
                const d = this.files.get(t.fileId)?.data;
                const v = d?.variables[t.varName];
                if (!v) continue;
                const u    = this._extractUnit(v.description);
                const name = this._traceName(t.varName, t.fileId);
                headers.push(u ? `${name} [${u}]` : name);
                columns.push(Array.from(this._getTransformedVariableData(t.fileId, t.varName)));
            }
        } else if (plot.mode === 'phase2dt') {
            for (const pt of plot.phaseTraces) {
                this._appendPhaseCSVTrace(headers, columns, pt, ['x', 'y']);
            }
        } else if (plot.mode === 'phase2d') {
            for (const pt of plot.phaseTraces) {
                this._appendPhaseCSVTrace(headers, columns, pt, ['x', 'y']);
            }
        } else if (plot.mode === 'phase3d') {
            for (const pt of plot.phaseTraces) {
                this._appendPhaseCSVTrace(headers, columns, pt, ['x', 'y', 'z']);
            }
        } else if (plot.mode === 'state-anim') {
            const slots = plot.stateSlots;
            const d = this.files.get(slots.fileId)?.data;
            if (d) {
                const timeVar  = this._getTimeVar(slots.fileId);
                if (timeVar) {
                    const timeUnit = this._timeUnitLabel(slots.fileId) || 's';
                    headers.push(this._isCalendarTime(slots.fileId) ? 'time [datetime UTC]' : `time [${timeUnit}]`);
                    columns.push(this._getTransformedTimeData(slots.fileId).map(value => this._formatTimeForExport(slots.fileId, value)));
                }
                const dim = Math.min(slots.x.length, slots.x.length >= 3 ? 3 : 2);
                // State variables first
                for (let i = 0; i < dim; i++) {
                    const name = slots.x[i];
                    const v = d.variables[name];
                    if (!v) continue;
                    const u = this._extractUnit(v.description);
                    headers.push(u ? `${name} [${u}]` : name);
                    columns.push(Array.from(this._getTransformedVariableData(slots.fileId, name)));
                }
                // Then derivatives
                for (let i = 0; i < dim; i++) {
                    const name = slots.dx[i];
                    if (!name) continue;
                    const v = d.variables[name];
                    if (!v) continue;
                    const u = this._extractUnit(v.description);
                    headers.push(u ? `${name} [${u}]` : name);
                    columns.push(Array.from(this._getTransformedVariableData(slots.fileId, name, { includeYOffset: false })));
                }
            }
        }

        if (!columns.length) return;

        const nRows = Math.max(...columns.map(c => c.length));
        const rows  = [headers.join(',')];
        for (let i = 0; i < nRows; i++) {
            rows.push(columns.map(c => (c[i] !== undefined ? c[i] : '')).join(','));
        }

        const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `${plot.mode}_export.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    _appendPhaseCSVTrace(headers, columns, phaseTrace, axes) {
        const d = this.files.get(phaseTrace.fileId)?.data;
        if (!d) return;

        const vars = axes.map(axis => d.variables[phaseTrace[axis]]);
        if (vars.some(v => !v)) return;

        const timeVar = this._getTimeVar(phaseTrace.fileId);
        const timeUnit = this._timeUnitLabel(phaseTrace.fileId);
        const timeName = timeVar?.name || 'time';

        headers.push(this._isCalendarTime(phaseTrace.fileId)
            ? `${timeName} [datetime UTC]`
            : (timeUnit ? `${timeName} [${timeUnit}]` : timeName));
        columns.push(this._getTransformedTimeData(phaseTrace.fileId).map(value => this._formatTimeForExport(phaseTrace.fileId, value)));

        axes.forEach((axis, index) => {
            const varName = phaseTrace[axis];
            const variable = vars[index];
            const unit = this._extractUnit(variable.description);
            const name = this._traceName(varName, phaseTrace.fileId);
            headers.push(unit ? `${name} [${unit}]` : name);
            columns.push(Array.from(this._getTransformedVariableData(phaseTrace.fileId, varName)));
        });
    }

    _compareAcrossFiles(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot || !this._hasContent(plot) || plot.mode === 'state-anim' || plot.mode === 'fft' || plot.mode === 'heatmap') return;
        const usesTimeTraces = ['timeseries', 'histogram'].includes(plot.mode);

        // Collect variables used. Overlay must be decided per trace signature,
        // not per file: a file can already contribute var_1 and still be
        // missing the newly added var_2.
        const vars = new Set();
        const existingTimeseries = new Set();
        const existingPhase = new Set();
        if (usesTimeTraces) {
            for (const t of plot.traces) {
                vars.add(t.varName);
                existingTimeseries.add(`${t.fileId}\u0000${t.varName}`);
            }
        } else {
            for (const pt of plot.phaseTraces) {
                vars.add(pt.x); vars.add(pt.y);
                if (pt.z) vars.add(pt.z);
                existingPhase.add(`${pt.fileId}\u0000${pt.x}\u0000${pt.y}\u0000${pt.z || ''}`);
            }
        }

        const foundByVar = new Map([...vars].map(v => [v, []]));
        const missingByFile = [];
        let addedCount = 0;
        let candidateCount = 0;

        // Clone traces with the new fileId where the variables exist. Dedupe originals first so
        // that running overlay a second time (after loading more files) doesn't multiply
        // copies by the number of files already overlaid.
        if (usesTimeTraces) {
            const seen = new Set();
            const originals = plot.traces.filter(t => {
                if (seen.has(t.varName)) return false;
                seen.add(t.varName);
                return true;
            });
            for (const [fid, entry] of this.files.entries()) {
                const candidates = originals.filter(t => !existingTimeseries.has(`${fid}\u0000${t.varName}`));
                if (!candidates.length) continue;
                candidateCount++;
                if (!this._canAddTraceWithFileTime(plot, fid, { silent: true })) {
                    Modal.alert(
                        'Incompatible time axes',
                        'This overlay would mix calendar, elapsed, or numeric time axes. Use matching time-axis modes first; a future compare option will let you choose timestamp vs elapsed matching.'
                    );
                    return;
                }
                const missing = [];
                for (const t of candidates) {
                    if (!entry.data.variables[t.varName]) {
                        missing.push(t.varName);
                        continue;
                    }
                    plot.traces.push({
                        varName: t.varName,
                        color:   this._nextTraceColor(plot.traces),
                        fileId:  fid,
                        visible: t.visible ?? true,
                    });
                    foundByVar.get(t.varName)?.push(entry.name);
                    addedCount++;
                }
                if (missing.length) missingByFile.push({ file: entry.name, vars: missing });
            }
        } else {
            const seen = new Set();
            const originals = plot.phaseTraces.filter(pt => {
                const key = `${pt.x}\u0000${pt.y}\u0000${pt.z || ''}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            for (const [fid, entry] of this.files.entries()) {
                const candidates = originals.filter(pt =>
                    !existingPhase.has(`${fid}\u0000${pt.x}\u0000${pt.y}\u0000${pt.z || ''}`)
                );
                if (!candidates.length) continue;
                candidateCount++;
                if (!this._canAddTraceWithFileTime(plot, fid, { silent: true })) {
                    Modal.alert(
                        'Incompatible time axes',
                        'This overlay would mix calendar, elapsed, or numeric time axes. Use matching time-axis modes first; a future compare option will let you choose timestamp vs elapsed matching.'
                    );
                    return;
                }
                const missing = new Set();
                for (const pt of candidates) {
                    const needed = [pt.x, pt.y, pt.z].filter(Boolean);
                    const missingForTrace = needed.filter(v => !entry.data.variables[v]);
                    if (missingForTrace.length) {
                        missingForTrace.forEach(v => missing.add(v));
                        continue;
                    }
                    plot.phaseTraces.push({
                        x: pt.x, y: pt.y, z: pt.z || null,
                        color:   this._nextTraceColor(plot.phaseTraces),
                        fileId:  fid,
                        visible: pt.visible ?? true,
                    });
                    needed.forEach(v => foundByVar.get(v)?.push(entry.name));
                    addedCount++;
                }
                if (missing.size) missingByFile.push({ file: entry.name, vars: [...missing] });
            }
        }

        if (candidateCount === 0) {
            Modal.alert(i18n.t('compareFilesErrorTitle'), i18n.t('compareFilesNoOthers'));
            return;
        }

        if (!addedCount) {
            const body = i18n.t('compareFilesNoMatches')
                .replace('{vars}', this._escapeHTML([...vars].join(', ')));
            Modal.alert(i18n.t('compareFilesErrorTitle'), body, { html: true });
            return;
        }

        this._rebuildPanel(panelId);
        this._showCompareSummary(foundByVar, missingByFile);
    }

    _showCompareSummary(foundByVar, missingByFile = []) {
        const foundRows = [...foundByVar.entries()]
            .filter(([, files]) => files.length)
            .map(([varName, files]) => {
                const uniqueFiles = [...new Set(files)];
                return `<li><b>${this._escapeHTML(varName)}</b>: ${uniqueFiles.map(f => this._escapeHTML(f)).join(', ')}</li>`;
            })
            .join('');
        const skippedRows = missingByFile.length
            ? `<p>${this._escapeHTML(i18n.t('compareFilesSkippedIntro'))}</p><ul>${
                missingByFile.map(({ file, vars }) =>
                    `<li>${this._escapeHTML(file)}: ${vars.map(v => this._escapeHTML(v)).join(', ')}</li>`
                ).join('')
            }</ul>`
            : '';
        const body = `
            <p>${this._escapeHTML(i18n.t('compareFilesSummaryIntro'))}</p>
            <ul>${foundRows}</ul>
            ${skippedRows}
        `;
        Modal.alert(i18n.t('compareFilesSummaryTitle'), body, { html: true });
    }

    _showPanelStats(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot || !this._hasContent(plot)) return;

        const entries = [];
        const addVar = (fileId, varName) => {
            const d = this.files.get(fileId)?.data;
            const variable = d?.variables[varName];
            if (!variable) return;
            const stats = this._statsForValues(this._getTransformedVariableData(fileId, varName));
            if (!stats) return;
            entries.push({
                name: this._traceName(varName, fileId),
                unit: this._extractUnit(variable.description),
                ...stats,
            });
        };

        if (plot.mode === 'timeseries' || plot.mode === 'fft') {
            plot.traces.forEach(t => addVar(t.fileId, t.varName));
        } else if (plot.mode === 'state-anim') {
            plot.stateSlots.x.forEach(v => addVar(plot.stateSlots.fileId, v));
            plot.stateSlots.dx.filter(Boolean).forEach(v => addVar(plot.stateSlots.fileId, v));
        } else {
            plot.phaseTraces.forEach(pt => {
                addVar(pt.fileId, pt.x);
                addVar(pt.fileId, pt.y);
                if (pt.z) addVar(pt.fileId, pt.z);
            });
        }

        if (!entries.length) {
            Modal.alert(i18n.t('panelStatsTitle'), i18n.t('statsNoNumeric'), { icon: 'Σ' });
            return;
        }

        const fmt = value => Number.isFinite(value) ? value.toPrecision(6) : '';
        const rows = entries.map(e => `
            <tr>
                <td>${this._escapeHTML(e.name)}</td>
                <td>${this._escapeHTML(e.unit)}</td>
                <td>${fmt(e.min)}</td>
                <td>${fmt(e.max)}</td>
                <td>${fmt(e.mean)}</td>
                <td>${fmt(e.rms)}</td>
            </tr>
        `).join('');
        const body = `
            <div class="stats-table-wrap">
                <table class="stats-table">
                    <thead>
                        <tr>
                            <th>${this._escapeHTML(i18n.t('statsVariable'))}</th>
                            <th>${this._escapeHTML(i18n.t('statsUnit'))}</th>
                            <th>${this._escapeHTML(i18n.t('statsMin'))}</th>
                            <th>${this._escapeHTML(i18n.t('statsMax'))}</th>
                            <th>${this._escapeHTML(i18n.t('statsMean'))}</th>
                            <th>${this._escapeHTML(i18n.t('statsRms'))}</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;
        Modal.alert(i18n.t('panelStatsTitle'), body, { icon: 'Σ', html: true, className: 'modal-dialog-stats' });
    }

    _statsForValues(values) {
        if (!values || !values.length) return null;
        let n = 0;
        let sum = 0;
        let sumSq = 0;
        let min = Infinity;
        let max = -Infinity;
        for (const value of values) {
            if (!Number.isFinite(value)) continue;
            n++;
            sum += value;
            sumSq += value * value;
            if (value < min) min = value;
            if (value > max) max = value;
        }
        if (!n) return null;
        return { min, max, mean: sum / n, rms: Math.sqrt(sumSq / n) };
    }


    // ─── Helpers ───────────────────────────────────────────────────

    _relayoutAll() {
        for (const [panelId, plot] of this.plots) {
            if (!plot.div) continue;
            Plotly.relayout(plot.div, this._themeRelayoutUpdate(plot));
            if (plot.fftDiv) Plotly.relayout(plot.fftDiv, this._themeRelayoutUpdate(plot));
            if (plot.histogramDiv) Plotly.relayout(plot.histogramDiv, this._themeRelayoutUpdate(plot));
            if (plot.heatmapDiv) {
                // Rebuild only the cached Plotly traces/layout so every
                // small-multiple y-axis picks up the theme. Source data and
                // calendar accumulators are deliberately not recomputed.
                this._renderCalendarHeatmapModels?.(panelId, plot, { preserveView: true });
            }
            this._refreshAxisDecorations(plot);
            // Origin cross marker color follows theme; restyle it separately.
            this._refreshOriginCross(plot);
        }
    }

    _themeRelayoutUpdate(plot) {
        const { bg, gridColor, fontColor, legendBg } = this._colors();
        // Theme changes must not include range/autorange/camera keys; those alter the user's current view.
        const update = {
            paper_bgcolor: bg,
            plot_bgcolor: bg,
            'font.color': fontColor,
            'font.size': 11,
            'font.family': 'system-ui, sans-serif',
            'legend.bgcolor': legendBg,
            'legend.bordercolor': gridColor,
            'legend.font.color': fontColor,
        };

        if (this._is3D(plot.mode) || this._isStateAnim3D(plot)) {
            update['scene.bgcolor'] = bg;
            for (const axis of ['xaxis', 'yaxis', 'zaxis']) {
                update[`scene.${axis}.gridcolor`] = gridColor;
                update[`scene.${axis}.linecolor`] = gridColor;
                update[`scene.${axis}.tickcolor`] = gridColor;
                update[`scene.${axis}.backgroundcolor`] = bg;
                update[`scene.${axis}.tickfont.color`] = fontColor;
            }
            return update;
        }

        for (const axis of ['xaxis', 'yaxis']) {
            update[`${axis}.gridcolor`] = gridColor;
            update[`${axis}.linecolor`] = gridColor;
            update[`${axis}.tickcolor`] = gridColor;
            update[`${axis}.zerolinecolor`] = gridColor;
            update[`${axis}.tickfont.color`] = fontColor;
            update[`${axis}.title.font.color`] = fontColor;
        }

        if (plot.timeseriesY2Enabled || plot.div?._fullLayout?.yaxis2) {
            update['yaxis2.linecolor'] = gridColor;
            update['yaxis2.tickcolor'] = gridColor;
            update['yaxis2.zerolinecolor'] = gridColor;
            update['yaxis2.tickfont.color'] = fontColor;
            update['yaxis2.title.font.color'] = fontColor;
        }

        return update;
    }

    /** Re-apply axis decoration colors (no-op now; X/Y/Z colors are theme-independent). */
    _refreshAxisDecorations(plot) {
        // Lines and diamond tips use fixed X=red, Y=green, Z=blue regardless of theme.
        // Function kept as a hook in case future styling needs theme refresh.
        void plot;
    }

    /** Re-apply theme color to the 2D origin cross marker. */
    _refreshOriginCross(plot) {
        if (!plot?.div?.data) return;
        const { fontColor } = this._colors();
        plot.div.data.forEach((t, i) => {
            if (t.name === '__origin__') {
                Plotly.restyle(plot.div, {
                    'marker.color': fontColor,
                    'marker.line.color': fontColor,
                }, [i]);
            }
        });
    }

    _hasContent(plot) {
        if (!plot) return false;
        if (plot.mode === 'timeseries') return plot.traces.length > 0;
        if (plot.mode === 'fft') return plot.traces.length > 0;
        if (plot.mode === 'histogram') return plot.traces.length > 0;
        if (plot.mode === 'heatmap') return plot.traces.length > 0;
        if (plot.mode === 'state-anim') return plot.stateSlots.x.length >= (plot.stateAnimDim || 2);
        return plot.phaseTraces.length > 0;
    }

    _is3D(mode) { return mode === 'phase2dt' || mode === 'phase3d'; }
    _isStateAnim3D(plot) { return plot?.mode === 'state-anim' && (plot.stateAnimDim || 2) === 3 && plot.stateSlots?.x?.length >= 3; }
    _normalizeTimeseriesDownsamplingLimit(limit) {
        if (limit == null || limit === false) return null;
        const n = Number(limit);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : PlotManager.DEFAULT_VISUAL_MAX_POINTS_TIMESERIES;
    }
    _normalizePhaseDownsamplingLimit(limit) {
        if (limit == null || limit === false) return null;
        const n = Number(limit);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : PlotManager.DEFAULT_VISUAL_MAX_POINTS_PHASE;
    }

    _isVisible(traceState) {
        return !!traceState && traceState.visible !== false && traceState.visible !== 'legendonly';
    }

    _canAddTraceWithFileTime(plot, fileId, options = {}) {
        if (!plot || !fileId) return true;
        if (!this._plotModeRequiresCompatibleTime(plot.mode)) return true;
        const primaryFileId = this._primaryTimeFileId(plot);
        if (!primaryFileId || primaryFileId === fileId) return true;
        const sameKind = this._timeKind(primaryFileId) === this._timeKind(fileId);
        const sameMode = this._timeDisplayMode(primaryFileId) === this._timeDisplayMode(fileId);
        if (sameKind && sameMode) return true;
        if (!options.silent) {
            Modal.alert(
                'Incompatible time axes',
                'This panel already uses a different time-axis mode. Switch files to the same Calendar/Elapsed mode before mixing traces.'
            );
        }
        return false;
    }

    _plotModeRequiresCompatibleTime(mode) {
        return mode === 'timeseries' || mode === 'phase2dt' || mode === 'fft' || mode === 'histogram' || mode === 'heatmap' || mode === 'correlation';
    }

    _padRange(min, max, pad = 0.05) {
        if (!Number.isFinite(min) || !Number.isFinite(max)) return [-1, 1];
        if (min === max) {
            const delta = Math.max(Math.abs(min) * pad, 1e-9, 1);
            return [min - delta, max + delta];
        }
        const span = max - min;
        return [min - span * pad, max + span * pad];
    }

    _exactRange(min, max) {
        if (!Number.isFinite(min) || !Number.isFinite(max)) return [-1, 1];
        if (min === max) return this._padRange(min, max);
        return [min, max];
    }

    _finiteExtent(arrays) {
        let min = Infinity;
        let max = -Infinity;
        for (const arr of arrays) {
            if (!arr) continue;
            for (const value of arr) {
                if (!Number.isFinite(value)) continue;
                if (value < min) min = value;
                if (value > max) max = value;
            }
        }
        return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
    }

    _timeseriesYExtentForSeries(plot, traceSeries, yArrays, xRange = null) {
        if (plot?.timeseriesStacked) {
            return this._finiteStackedYExtentInXRange(traceSeries, xRange);
        }
        return xRange
            ? this._finiteYExtentInXRange(traceSeries, xRange)
            : this._finiteExtent(yArrays);
    }

    _finiteStackedYExtentInXRange(series, xRange = null) {
        const items = (series || []).filter(item => item?.x?.length && item?.y?.length);
        if (!items.length) return null;
        const hasRange = Array.isArray(xRange);
        const a = hasRange ? this._coerceAxisValue(xRange[0]) : null;
        const b = hasRange ? this._coerceAxisValue(xRange[1]) : null;
        const minX = hasRange && Number.isFinite(a) && Number.isFinite(b) ? Math.min(a, b) : -Infinity;
        const maxX = hasRange && Number.isFinite(a) && Number.isFinite(b) ? Math.max(a, b) : Infinity;
        let min = 0;
        let max = 0;
        let found = false;
        const count = Math.max(...items.map(item => Math.min(item.x.length, item.y.length)));
        for (let i = 0; i < count; i++) {
            let positive = 0;
            let negative = 0;
            let any = false;
            for (const item of items) {
                const n = Math.min(item.x.length, item.y.length);
                if (i >= n) continue;
                const xv = this._coerceAxisValue(item.x[i]);
                if (!Number.isFinite(xv) || xv < minX || xv > maxX) continue;
                const yv = Number(item.y[i]);
                if (!Number.isFinite(yv)) continue;
                if (yv >= 0) positive += yv;
                else negative += yv;
                any = true;
            }
            if (!any) continue;
            found = true;
            if (negative < min) min = negative;
            if (positive > max) max = positive;
        }
        return found ? { min, max } : null;
    }

    _autoScalePlot(panelId, plot = this.plots.get(panelId)) {
        if (!plot?.div) return Promise.resolve();

        if (plot.mode === 'fft') {
            return this._autoScaleFftPanel(panelId, plot);
        }

        if (plot.mode === 'histogram') {
            return this._autoScaleHistogramPanel(panelId, plot);
        }

        if (plot.mode === 'heatmap') {
            return this._autoScaleHeatmapPanel(panelId, plot);
        }

        if (plot.mode === 'correlation') {
            this._autoScaleCorrelationTime(plot);
            // Results pane: restore the fixed r range and the reversed pair order
            // (P1 on top). Plain autorange would flip P1..Pn vertically.
            if (plot.correlationDiv) Plotly.relayout(plot.correlationDiv, { 'xaxis.range': [-1, 1], 'yaxis.autorange': 'reversed' });
            return Promise.resolve();
        }

        if (plot.mode === 'timeseries') {
            const visibleTraces = plot.traces.filter(t => this._isVisible(t));
            if (!visibleTraces.length) {
                const update = { 'xaxis.autorange': true, 'yaxis.autorange': true };
                if (plot.timeseriesY2Enabled) update['yaxis2.autorange'] = true;
                return Plotly.relayout(plot.div, update)
                    .then(() => this._refreshElapsedDateTimeAxisTicks(plot));
            }

            const xArrays = [];
            const yArrays = [];
            const y2Arrays = [];
            const traceSeries = [];
            const traceSeriesY2 = [];
            for (const t of visibleTraces) {
                const d = this.files.get(t.fileId)?.data;
                const v = d?.variables?.[t.varName];
                if (!d || !v || v.kind === 'parameter') continue;
                const x = this._getTransformedTimeData(t.fileId);
                const y = this._getTransformedVariableData(t.fileId, t.varName);
                xArrays.push(x);
                if (this._traceYAxis(t, plot) === 'y2') {
                    traceSeriesY2.push({ x, y });
                    y2Arrays.push(y);
                } else {
                    traceSeries.push({ x, y });
                    yArrays.push(y);
                }
            }

            const xExtent = this._finiteExtent(xArrays);
            const yExtent = this._timeseriesYExtentForSeries(plot, traceSeries, yArrays);
            const y2Extent = plot.timeseriesY2Enabled
                ? this._timeseriesYExtentForSeries({ ...plot, timeseriesStacked: false }, traceSeriesY2, y2Arrays)
                : null;
            const update = {};
            if (xExtent) {
                const primaryFileId = visibleTraces[0]?.fileId;
                const timeVar = this._getTimeVar(primaryFileId);
                const isCalendarAxis = this._timeDisplayModeForVar(primaryFileId, timeVar) === 'calendar';
                const xRange = this._exactRange(xExtent.min, xExtent.max);
                update['xaxis.range'] = isCalendarAxis ? this._plotlyTimeArray(primaryFileId, xRange, timeVar) : xRange;
                update['xaxis.autorange'] = false;
            }
            else update['xaxis.autorange'] = true;
            if (yExtent) update['yaxis.range'] = this._padRange(yExtent.min, yExtent.max);
            else update['yaxis.autorange'] = true;
            if (plot.timeseriesY2Enabled) {
                if (y2Extent) {
                    update['yaxis2.range'] = this._padRange(y2Extent.min, y2Extent.max);
                    update['yaxis2.autorange'] = false;
                } else {
                    update['yaxis2.autorange'] = true;
                }
            }
            const tickRange = xExtent ? [xExtent.min, xExtent.max] : null;
            return Plotly.relayout(plot.div, update)
                .then(() => this._refreshElapsedDateTimeAxisTicks(plot, tickRange));
        }

        if (plot.mode === 'phase2d') {
            const visibleTraces = plot.phaseTraces.filter(pt => this._isVisible(pt));
            if (!visibleTraces.length) {
                return Plotly.relayout(plot.div, { 'xaxis.autorange': true, 'yaxis.autorange': true });
            }

            const xArrays = [];
            const yArrays = [];
            for (const pt of visibleTraces) {
                const visual = this._phaseVisualDataForTrace(plot, pt);
                if (!visual) continue;
                xArrays.push(visual.x);
                yArrays.push(visual.y);
            }

            const xExtent = this._finiteExtent(xArrays);
            const yExtent = this._finiteExtent(yArrays);
            const update = {};
            if (xExtent) {
                update['xaxis.range'] = this._padRange(xExtent.min, xExtent.max);
                update['xaxis.autorange'] = false;
            }
            else update['xaxis.autorange'] = true;
            if (yExtent) {
                update['yaxis.range'] = this._padRange(yExtent.min, yExtent.max);
                update['yaxis.autorange'] = false;
            }
            else update['yaxis.autorange'] = true;
            return Plotly.relayout(plot.div, update);
        }

        if (this._is3D(plot.mode)) {
            const layout = this._buildPhase3DLayout(plot, plot.mode === 'phase2dt');
            const update = {
                'scene.xaxis.range': layout.scene.xaxis.range,
                'scene.yaxis.range': layout.scene.yaxis.range,
                'scene.zaxis.range': layout.scene.zaxis.range,
            };
            const is2dt = plot.mode === 'phase2dt';
            if (is2dt) {
                Object.assign(update, this._timeAxisRelayoutUpdate(layout.scene.xaxis, 'scene.xaxis'));
            }
            const homeCamera = plot.homeCamera || (is2dt
                ? { eye: { x: 1.25, y: -1.25, z: 1.25 }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } }
                : { eye: { x: 1.25, y: 1.25, z: 1.25 }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } });
            update['scene.camera'] = { ...homeCamera, projection: { type: plot.projection || 'orthographic' } };
            return Plotly.relayout(plot.div, update).then(() => this._updateCameraOverlay(plot));
        }

        if (plot.mode === 'state-anim') {
            const dim = plot.stateAnimDim || 2;
            if (dim >= 3) {
                this._stateAnimResetView(plot);
                return Promise.resolve();
            }

            const xName = plot.stateSlots?.x?.[0];
            const yName = plot.stateSlots?.x?.[1];
            const fileId = plot.stateSlots?.fileId;
            const d = this.files.get(fileId)?.data;
            if (!d?.variables?.[xName] || !d?.variables?.[yName]) {
                return Plotly.relayout(plot.div, { 'xaxis.autorange': true, 'yaxis.autorange': true });
            }

            const xExtent = this._finiteExtent([this._getTransformedVariableData(fileId, xName)]);
            const yExtent = this._finiteExtent([this._getTransformedVariableData(fileId, yName)]);
            const update = {};
            if (xExtent) update['xaxis.range'] = this._padRange(xExtent.min, xExtent.max);
            else update['xaxis.autorange'] = true;
            if (yExtent) update['yaxis.range'] = this._padRange(yExtent.min, yExtent.max);
            else update['yaxis.autorange'] = true;
            return Plotly.relayout(plot.div, update);
        }

        return Promise.resolve();
    }

    _rebuildPanel(panelId, options = {}) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!panelEl) return;
        const restoreView = options.restoreView || (options.preserveView ? this._capturePlotView(plot) : null);
        this._destroyChart(panelId);
        if (restoreView) plot._pendingViewRestore = restoreView;
        plot.markerTraceIdx = null;
        if (this._hasContent(plot)) {
            if (plot.mode === 'state-anim') {
                this._createStateAnimChart(panelId, panelEl);
            } else {
                this._createChart(panelId, panelEl);
            }
        } else {
            document.body.classList.remove('cursor-dragging', 'cursor-box-dragging');
            if (plot.mode === 'timeseries' || plot.mode === 'fft') {
                plot.cursors = this._defaultCursors();
                plot.cursorsSpectrum = this._defaultCursors();
            }
            const ph = panelEl.querySelector('.layout-panel-placeholder');
            if (ph) { ph.style.display = ''; ph.classList.remove('drag-over'); }
            this._setPendingOverlay(panelId, panelEl, false);
            this._hideCursorBox(panelEl);
            this._updatePlaceholder(panelId, panelEl);
            this._refreshActionBtns(panelId);
        }
    }

    _relayoutLegendAll() {
        const { gridColor, legendBg } = this._colors();
        const legend = this._legendConfig(legendBg, gridColor);
        for (const [, plot] of this.plots) {
            if (!plot.div) continue;
            const update = {
                legend,
                showlegend: this.legendPosition !== 'hidden',
            };
            if (plot.mode === 'timeseries') {
                update.margin = this._marginConfig();
                update.margin.b += 6;
            }
            else if (plot.mode === 'phase2d') update.margin = { l: 60, r: 15, t: this.legendPosition === 'above' ? 50 : 10, b: 50 };
            Plotly.relayout(plot.div, update);
            if (plot.fftDiv) Plotly.relayout(plot.fftDiv, update);
            if (plot.histogramDiv) Plotly.relayout(plot.histogramDiv, update);
            if (plot.heatmapDiv) Plotly.relayout(plot.heatmapDiv, { ...update, showlegend: false });
        }
    }

    _rebuildAllPanels() {
        for (const [id] of this.plots) this._rebuildPanel(id);
    }

    _makeState() {
        return {
            div: null, mode: 'timeseries',
            traces: [],                                    // timeseries: [{varName, color}]
            phaseTraces: [],                               // phase: [{x, y, z, color}] — completed traces
            phasePending: { x: null, y: null, z: null, fileId: null },  // phase trace being built
            projection: 'orthographic',                    // 3D camera projection
            markerTraceIdx: null,                          // index of the hover-marker trace in plot.div.data
            timeseriesStacked: false,
            timeseriesY2Enabled: false,
            showMissingData: false,
            equalAspect2D: false,
            resizeObserver: null,
            fftDiv: null,
            fftContainer: null,
            fft: this._defaultFftState?.() || null,
            histogramDiv: null,
            histogramContainer: null,
            histogram: this._defaultHistogramState?.() || null,
            heatmapDiv: null,
            heatmapContainer: null,
            heatmap: this._defaultHeatmapState?.() || null,
            correlationDiv: null,
            correlationContainer: null,
            correlation: this._defaultCorrelationState?.() || null,
            // state-anim mode
            stateSlots:   { x: [], dx: [], fileId: null }, // x: [varName,...], dx: [derName,...]
            stateAnimDim: 2,
            stateConfig:  { showFullTrace: true, showTrace: true, showArrowX: true, showArrowDx: true, normalizeDx: true, dynamicZoom: false },
            showCameraOverlay: false,
            cameraOverlayEl: null,
            homeCamera: null,
            animFrame:    0,                               // current time index
            animPlaying:  false,
            animSpeed:    1,
            animRAF:      null,
            autoPlayOnRender: false,
            liveView: this._defaultLiveViewPolicy('timeseries'),
        };
    }

    _defaultLiveViewPolicy(mode = 'timeseries') {
        if (mode === 'timeseries') {
            return { ...this.liveViewDefaults.timeseries };
        }
        return { ...this.liveViewDefaults.phase };
    }

    _normalizeLiveViewPolicy(plot) {
        if (!plot) return this._defaultLiveViewPolicy();
        const current = plot.liveView || {};
        if (plot.mode === 'timeseries') {
            const xMode = ['autoscale', 'sliding', 'pin-start', 'keep'].includes(current.xMode)
                ? current.xMode
                : 'pin-start';
            const yMode = ['autoscale', 'expand', 'keep'].includes(current.yMode)
                ? current.yMode
                : 'expand';
            const windowSeconds = Number.isFinite(Number(current.windowSeconds)) && Number(current.windowSeconds) > 0
                ? Number(current.windowSeconds)
                : 60;
            return { xMode, yMode, windowSeconds };
        }
        return {
            viewMode: current.viewMode === 'autoscale' ? 'autoscale' : 'keep',
        };
    }

    setLiveViewPolicy(panelId, patch = {}) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        plot.liveView = { ...this._normalizeLiveViewPolicy(plot), ...patch };
        this._refreshActionBtns(panelId);
    }

    setGlobalLiveViewPolicy(mode, patch = {}, options = {}) {
        const key = mode === 'timeseries' ? 'timeseries' : 'phase';
        const base = key === 'timeseries'
            ? this._normalizeLiveViewPolicy({ mode: 'timeseries', liveView: this.liveViewDefaults.timeseries })
            : this._normalizeLiveViewPolicy({ mode: 'phase2d', liveView: this.liveViewDefaults.phase });
        this.liveViewDefaults[key] = { ...(this.liveViewDefaults[key] || {}), ...base, ...patch };
        for (const [, plot] of this.plots) {
            if (key === 'timeseries' && plot.mode !== 'timeseries') continue;
            if (key === 'phase' && plot.mode === 'timeseries') continue;
            if (plot.mode === 'state-anim') continue;
            plot.liveView = { ...(plot.liveView || {}), ...this._normalizeLiveViewPolicy(plot), ...patch };
        }
        if (options.applyNow) this._applyLiveViewPolicyToCurrentPlots(key);
    }

    _applyLiveViewPolicyToCurrentPlots(key) {
        for (const [panelId, plot] of this.plots) {
            if (!plot?.div) continue;
            if (key === 'timeseries') {
                if (plot.mode !== 'timeseries') continue;
                const captured = this._capturePlotView(plot);
                if (!captured) continue;
                const view = this._timeseriesLiveAppendView(plot, this._primaryTimeFileId(plot) || this.activeFileId, captured, this._normalizeLiveViewPolicy(plot));
                this._applyLiveViewRelayout(plot, view);
            } else {
                // FFT panels keep their own view; the phase autoscale policy
                // must not reset their time plot or spectrum.
                if (plot.mode === 'timeseries' || plot.mode === 'state-anim' || plot.mode === 'fft') continue;
                const policy = this._normalizeLiveViewPolicy(plot);
                if (policy.viewMode === 'autoscale') this._autoScalePlot(panelId, plot);
            }
        }
    }

    _applyLiveViewRelayout(plot, view) {
        if (!plot?.div || !view || view.mode !== '2d') return Promise.resolve();
        const update = {};
        if (view.xRange) {
            update['xaxis.range'] = view.xRange;
            update['xaxis.autorange'] = false;
        } else {
            update['xaxis.autorange'] = true;
        }
        if (view.yRange) {
            update['yaxis.range'] = view.yRange;
            update['yaxis.autorange'] = false;
        } else {
            update['yaxis.autorange'] = true;
        }
        if (view.y2Range && plot.timeseriesY2Enabled) {
            update['yaxis2.range'] = view.y2Range;
            update['yaxis2.autorange'] = false;
        }
        return Plotly.relayout(plot.div, update).then(() => this._refreshPanelDomOverlays(plot));
    }

    useCurrentZoomForLiveWindow(panelId) {
        const plot = this.plots.get(panelId);
        const view = this._capturePlotView(plot);
        if (!plot || plot.mode !== 'timeseries' || !view?.xRange) return;
        const start = this._coerceAxisValue(view.xRange[0]);
        const end = this._coerceAxisValue(view.xRange[1]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        const axis = plot.div?._fullLayout?.xaxis;
        const divisor = axis?.type === 'date' ? 1000 : 1;
        plot.liveView = {
            ...this._normalizeLiveViewPolicy(plot),
            xMode: 'sliding',
            windowSeconds: Math.max((end - start) / divisor, 1e-9),
        };
        this._refreshActionBtns(panelId);
    }

    _liveAppendRestoreView(plot, fileId, captured, previousData, newData) {
        if (!plot || !captured) return null;
        const policy = this._normalizeLiveViewPolicy(plot);
        if (plot.mode === 'timeseries') {
            return this._timeseriesLiveAppendView(plot, fileId, captured, policy);
        }
        if (plot.mode === 'phase2d') {
            return policy.viewMode === 'autoscale' ? null : captured;
        }
        return captured;
    }

    _timeseriesLiveAppendView(plot, fileId, captured, policy) {
        const visibleTraces = plot.traces.filter(t => this._isVisible(t));
        if (!visibleTraces.length) return captured;

        const traceSeries = [];
        const traceSeriesY2 = [];
        const xArrays = [];
        const yArrays = [];
        const y2Arrays = [];
        for (const trace of visibleTraces) {
            const data = this.files.get(trace.fileId)?.data;
            const variable = data?.variables?.[trace.varName];
            if (!variable || variable.kind === 'parameter') continue;
            const x = this._getTransformedTimeData(trace.fileId);
            const y = this._getTransformedVariableData(trace.fileId, trace.varName);
            xArrays.push(x);
            if (this._traceYAxis(trace, plot) === 'y2') {
                traceSeriesY2.push({ x, y });
                y2Arrays.push(y);
            } else {
                traceSeries.push({ x, y });
                yArrays.push(y);
            }
        }

        const xExtent = this._finiteExtent(xArrays);
        const nextView = { ...captured };
        const primaryFileId = visibleTraces[0]?.fileId || fileId;
        const timeVar = this._getTimeVar(primaryFileId);
        const isCalendarAxis = this._timeDisplayModeForVar(primaryFileId, timeVar) === 'calendar';
        const formatX = range => isCalendarAxis ? this._plotlyTimeArray(primaryFileId, range, timeVar) : range;

        if (policy.xMode === 'autoscale') {
            nextView.xRange = null;
        } else if (xExtent) {
            const end = xExtent.max;
            if (policy.xMode === 'sliding') {
                const seconds = Number(policy.windowSeconds) || 60;
                const width = isCalendarAxis ? seconds * 1000 : seconds;
                nextView.xRange = formatX([end - width, end]);
            } else if (policy.xMode === 'pin-start') {
                const capturedStart = this._coerceAxisValue(captured.xRange?.[0]);
                const start = Number.isFinite(capturedStart) ? capturedStart : xExtent.min;
                nextView.xRange = formatX([start, end]);
            } else {
                nextView.xRange = captured.xRange;
            }
        }

        if (policy.yMode === 'autoscale') {
            nextView.yRange = null;
            if (plot.timeseriesY2Enabled) nextView.y2Range = null;
        } else if (policy.yMode === 'expand') {
            const yExtent = nextView.xRange
                ? this._timeseriesYExtentForSeries(plot, traceSeries, yArrays, nextView.xRange)
                : this._timeseriesYExtentForSeries(plot, traceSeries, yArrays);
            const y2Extent = plot.timeseriesY2Enabled
                ? (nextView.xRange
                    ? this._timeseriesYExtentForSeries({ ...plot, timeseriesStacked: false }, traceSeriesY2, y2Arrays, nextView.xRange)
                    : this._timeseriesYExtentForSeries({ ...plot, timeseriesStacked: false }, traceSeriesY2, y2Arrays))
                : null;
            const oldRange = captured.yRange?.map(Number);
            if (!yExtent) {
                nextView.yRange = captured.yRange;
            } else if (oldRange?.every(Number.isFinite)) {
                const oldMin = Math.min(oldRange[0], oldRange[1]);
                const oldMax = Math.max(oldRange[0], oldRange[1]);
                const min = Math.min(oldMin, yExtent.min);
                const max = Math.max(oldMax, yExtent.max);
                const expanded = min === oldMin && max === oldMax
                    ? captured.yRange
                    : (oldRange[0] <= oldRange[1] ? [min, max] : [max, min]);
                nextView.yRange = min === max ? this._padRange(min, max) : expanded;
            } else {
                nextView.yRange = this._padRange(yExtent.min, yExtent.max);
            }
            if (plot.timeseriesY2Enabled) {
                const oldY2Range = captured.y2Range?.map(Number);
                if (!y2Extent) {
                    nextView.y2Range = captured.y2Range;
                } else if (oldY2Range?.every(Number.isFinite)) {
                    const oldMin = Math.min(oldY2Range[0], oldY2Range[1]);
                    const oldMax = Math.max(oldY2Range[0], oldY2Range[1]);
                    const min = Math.min(oldMin, y2Extent.min);
                    const max = Math.max(oldMax, y2Extent.max);
                    nextView.y2Range = min === max ? this._padRange(min, max) : (oldY2Range[0] <= oldY2Range[1] ? [min, max] : [max, min]);
                } else {
                    nextView.y2Range = this._padRange(y2Extent.min, y2Extent.max);
                }
            }
        } else {
            nextView.yRange = captured.yRange;
            if (plot.timeseriesY2Enabled) nextView.y2Range = captured.y2Range;
        }

        return nextView;
    }

    _finiteYExtentInXRange(series, xRange) {
        const a = this._coerceAxisValue(xRange?.[0]);
        const b = this._coerceAxisValue(xRange?.[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        const minX = Math.min(a, b);
        const maxX = Math.max(a, b);
        let min = Infinity;
        let max = -Infinity;
        for (const item of series || []) {
            const x = item?.x || [];
            const y = item?.y || [];
            const count = Math.min(x.length, y.length);
            for (let i = 0; i < count; i++) {
                const xv = this._coerceAxisValue(x[i]);
                if (!Number.isFinite(xv) || xv < minX || xv > maxX) continue;
                const yv = Number(y[i]);
                if (!Number.isFinite(yv)) continue;
                if (yv < min) min = yv;
                if (yv > max) max = yv;
            }
        }
        return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
    }

    _getTimeVar(fileId = this.activeFileId) {
        const d = fileId ? this.files.get(fileId)?.data : null;
        if (!d) return null;
        return Object.values(d.variables).find(v => v.kind === 'abscissa') || null;
    }

    /**
     * Compute a range [min, max] that covers every finite value in `arrays` AND includes 0,
     * with a symmetric relative `pad` on each side. Used for 3D scene axes so the
     * origin-anchored axis lines can be drawn without triggering Plotly autorange expansion.
     *
     * If the positive side is too small (e.g. all-negative data like [-20, 0]), the upper
     * bound is extended so the positive side is at least `minPositiveFrac` of the negative
     * extent. Without this, the +axis line would be constrained to the tiny padding region
     * and would force the other two lines to match that length — visibly tiny.
     */
    _rangeIncluding0(arrays, pad = 0.05, minPositiveFrac = 0.3) {
        let lo = Infinity, hi = -Infinity;
        for (const arr of arrays) {
            if (!arr) continue;
            for (const v of arr) {
                if (Number.isFinite(v)) {
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
            }
        }
        if (!Number.isFinite(lo)) { lo = -1; hi = 1; }
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
        // Guarantee the +axis line has meaningful room to draw.
        if (lo < 0) hi = Math.max(hi, -lo * minPositiveFrac);
        const span = Math.max(hi - lo, 1e-12);
        return [lo - pad * span, hi + pad * span];
    }

    _capturePlotView(plot, options = {}) {
        if (!plot?.div?._fullLayout) return null;
        const fl = plot.div._fullLayout;
        const axisRange = (axis) => {
            if (!Array.isArray(axis?.range)) return null;
            if (options.manualRangesOnly && axis.autorange !== false) return null;
            return [...axis.range];
        };
        const manualAxisRange = (axis) => axis?.autorange === false && Array.isArray(axis.range)
            ? [...axis.range]
            : null;
        if (this._is3D(plot.mode) || this._isStateAnim3D(plot)) {
            const scene = fl.scene;
            if (!scene) return null;
            return {
                mode: '3d',
                camera: scene.camera ? JSON.parse(JSON.stringify(scene.camera)) : null,
                xRange: axisRange(scene.xaxis),
                yRange: axisRange(scene.yaxis),
                zRange: axisRange(scene.zaxis),
            };
        }

        const view = {
            mode: '2d',
            xRange: axisRange(fl.xaxis),
            yRange: axisRange(fl.yaxis),
            y2Range: axisRange(fl.yaxis2),
        };
        // FFT panels have a second plot: keep the spectrum's manual zoom
        // across rebuilds (live update, transforms) too.
        if (plot.mode === 'fft') {
            const sfl = plot.fftDiv?._fullLayout;
            view.fftSpectrum = {
                xRange: manualAxisRange(sfl?.xaxis),
                yRange: manualAxisRange(sfl?.yaxis),
            };
        } else if (plot.mode === 'histogram') {
            const hfl = plot.histogramDiv?._fullLayout;
            view.histogramBars = {
                xRange: manualAxisRange(hfl?.xaxis),
                yRange: manualAxisRange(hfl?.yaxis),
            };
        } else if (plot.mode === 'heatmap') {
            const hfl = plot.heatmapDiv?._fullLayout;
            view.heatmapCalendar = {
                xRange: manualAxisRange(hfl?.xaxis),
                yRange: manualAxisRange(hfl?.yaxis),
            };
        }
        return view;
    }

    _timeShiftForMode(transform, mode) {
        const value = transform?.timeShift;
        if (value === '' || value === null || value === undefined) return 0;
        if (mode === 'calendar') return this._parseDurationMs(value);
        if (mode === 'elapsedDateTime') {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : this._parseDurationMs(value) / 1000;
        }
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : 0;
    }

    _mapTimeRangeBetweenModes(fileId, range, fromMode, toMode, fromTransform = null, toTransform = null) {
        if (!Array.isArray(range) || range.length < 2 || fromMode === toMode) return range;
        if (fromMode === 'index' || toMode === 'index') return null;
        const origin = this._timeOriginMs(fileId);
        const fromShift = this._timeShiftForMode(fromTransform, fromMode);
        const toShift = this._timeShiftForMode(toTransform, toMode);
        const toAbsoluteMs = (value) => {
            if (fromMode === 'calendar') return this._coerceAxisValue(value) - fromShift;
            if (fromMode === 'elapsedDateTime' || fromMode === 'elapsedSeconds') {
                const numeric = Number(value);
                return Number.isFinite(numeric) ? origin + (numeric - fromShift) * 1000 : NaN;
            }
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : NaN;
        };
        const fromAbsoluteMs = (value) => {
            if (!Number.isFinite(value)) return value;
            if (toMode === 'calendar') return new Date(value + toShift).toISOString();
            if (toMode === 'elapsedDateTime' || toMode === 'elapsedSeconds') return (value - origin) / 1000 + toShift;
            return value;
        };
        const mapped = range.map(value => fromAbsoluteMs(toAbsoluteMs(value)));
        return mapped.every(value => value !== null && value !== undefined && (typeof value === 'string' || Number.isFinite(value)))
            ? mapped
            : range;
    }

    _restorePlotView(plot, view) {
        if (!plot?.div || !view) return Promise.resolve();
        const update = {};
        if (view.mode === '3d') {
            if (view.xRange) { update['scene.xaxis.range'] = view.xRange; update['scene.xaxis.autorange'] = false; }
            if (view.yRange) { update['scene.yaxis.range'] = view.yRange; update['scene.yaxis.autorange'] = false; }
            if (view.zRange) { update['scene.zaxis.range'] = view.zRange; update['scene.zaxis.autorange'] = false; }
            if (view.camera) update['scene.camera'] = view.camera;
        } else {
            if (view.xRange) { update['xaxis.range'] = view.xRange; update['xaxis.autorange'] = false; }
            if (view.yRange) { update['yaxis.range'] = view.yRange; update['yaxis.autorange'] = false; }
            if (view.y2Range && plot.timeseriesY2Enabled) { update['yaxis2.range'] = view.y2Range; update['yaxis2.autorange'] = false; }
        }
        if (!Object.keys(update).length) return Promise.resolve();
        return Plotly.relayout(plot.div, update).then(() => this._updateCameraOverlay(plot));
    }

    _varUnit(varName, fileId = this.activeFileId) {
        if (!varName) return '';
        const d = fileId ? this.files.get(fileId)?.data : null;
        if (!d) return '';
        const v = d.variables[varName];
        return v ? this._extractUnit(v.description) : '';
    }

    _traceName(label, fileId) {
        const displayLabel = this._variableLabel(label, fileId) || label;
        if (this.files.size >= 2 && fileId) {
            const f = this.files.get(fileId);
            if (f) return `[${f.name}] ${displayLabel}`;
        }
        return displayLabel;
    }

    _findTimeIdx(times, xVal) {
        if (!times || !times.length) return 0;
        const numericX = Number(xVal);
        if (!Number.isFinite(numericX)) {
            const parsed = Date.parse(String(xVal));
            if (Number.isFinite(parsed)) xVal = parsed;
        } else {
            xVal = numericX;
        }
        if (times.length === 1 || xVal <= times[0]) return 0;
        const last = times.length - 1;
        if (xVal >= times[last]) return last;

        let lo = 0;
        let hi = last;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (times[mid] <= xVal) lo = mid;
            else hi = mid;
        }

        return (xVal - times[lo]) <= (times[hi] - xVal) ? lo : hi;
    }

    _escapeHTML(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch]));
    }

    _formatHTMLNumber(value) {
        return Number.isFinite(value) ? value.toPrecision(5) : this._escapeHTML(value);
    }

    _extractUnit(description) {
        if (!description) return '';
        const match = description.match(/\[([^\]]+)\]/);
        if (!match) return '';
        const parts = match[1].split('|');
        return (parts[1] ?? parts[0]).trim();
    }

    _colors() {
        const isDark   = this.theme === 'dark';
        return {
            bg:        isDark ? '#2d2d2d' : '#ffffff',
            gridColor: isDark ? '#3d3d3d' : '#e8e8e8',
            fontColor: isDark ? '#d0d0d0' : '#333333',
            legendBg:  isDark ? 'rgba(30,30,30,0.85)' : 'rgba(255,255,255,0.85)',
        };
    }

    _legendConfig(legendBg, gridColor) {
        const base = { showlegend: true, bgcolor: legendBg, bordercolor: gridColor, borderwidth: 1, font: { size: 10 } };
        switch (this.legendPosition) {
            case 'above':   return { ...base, orientation: 'h', x: 0.5, xanchor: 'center', y: 1.02, yanchor: 'bottom' };
            case 'right':   return { ...base, x: 1.02, y: 0.5, xanchor: 'left', yanchor: 'middle' };
            case 'hidden':  return { ...base, visible: false };
            default:
                switch (this.legendOverlayCorner) {
                    case 'tr': return { ...base, x: 0.99, y: 0.99, xanchor: 'right', yanchor: 'top' };
                    case 'bl': return { ...base, x: 0.01, y: 0.01, xanchor: 'left', yanchor: 'bottom' };
                    case 'br': return { ...base, x: 0.99, y: 0.01, xanchor: 'right', yanchor: 'bottom' };
                    default:   return { ...base, x: 0.01, y: 0.99, xanchor: 'left', yanchor: 'top' };
                }
        }
    }

    _marginConfig() {
        return this.legendPosition === 'above'
            ? { l: 55, r: 15, t: 50, b: 40 }
            : { l: 55, r: 15, t: 10, b: 40 };
    }

    static COLORS = [
        '#2196F3', '#FF5722', '#4CAF50', '#FF9800',
        '#9C27B0', '#00BCD4', '#F44336', '#8BC34A',
    ];
    static GL_POINT_THRESHOLD = 50000;
    static DEFAULT_VISUAL_MAX_POINTS_TIMESERIES = 2000;
    static DEFAULT_VISUAL_MAX_POINTS_PHASE = 4000;
    static MAX_MENU_VISUAL_POINTS = 10000;
    static LIVE_RELAYOUT_MAX_SOURCE_POINTS = 1250000;
    static LIVE_RELAYOUT_MAX_VIEW_POINTS = 250000;

    _nextColor(idx) { return PlotManager.COLORS[idx % PlotManager.COLORS.length]; }
    _nextTraceColor(traceStates) {
        const used = new Set((traceStates || []).map(t => t?.color).filter(Boolean));
        const paletteColor = PlotManager.COLORS.find(color => !used.has(color));
        if (paletteColor) return paletteColor;

        const start = traceStates?.length || 0;
        for (let i = 0; i < 360; i++) {
            const hue = Math.round((start + i) * 137.508) % 360;
            const color = `hsl(${hue}, 70%, 45%)`;
            if (!used.has(color)) return color;
        }
        return this._nextColor(used.size);
    }
}

installPlotDataMethods(PlotManager);
installPlotStateMethods(PlotManager);
installPlotInteractionMethods(PlotManager);
installPlotFftMethods(PlotManager);
installPlotHistogramMethods(PlotManager);
installPlotCorrelationMethods(PlotManager);
installPlotCalendarHeatmapMethods(PlotManager);

export default PlotManager;
