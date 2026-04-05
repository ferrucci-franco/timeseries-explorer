/**
 * PlotManager — Plotly chart lifecycle tied to the dynamic layout
 *
 * Panel modes:
 *   'timeseries'  — one or more variables vs time (default)
 *   'phase2d'     — x(t) vs y(t)  → 2-D scatter
 *   'phase2dt'    — x(t) vs y(t) vs t → 3-D scatter (z = time)
 *   'phase3d'     — x(t) vs y(t) vs z(t) → 3-D scatter
 *
 * Panel state per panelId:
 *   { div, mode, traces:[{varName,color}], phaseTraces:[{x,y,z,color}], phasePending:{x,y,z}, resizeObserver }
 */

class PlotManager {
    constructor() {
        this.plots          = new Map();
        this.files          = new Map();   // fileId → { name, data }
        this.activeFileId   = null;
        this.theme          = 'light';
        this.syncAxes       = true;
        this.legendPosition = 'overlay';
        this._syncing       = false;
        this.syncHover      = false;
        this._hovering      = false;

        this.onPanelMount   = (id, el) => this._mountPanel(id, el);
        this.onPanelUnmount = (id)     => this._unmountPanel(id);
    }

    // ─── Public API ────────────────────────────────────────────────

    /** Active file's data — used as fallback / for addTrace validation */
    get data() {
        return this.activeFileId ? (this.files.get(this.activeFileId)?.data ?? null) : null;
    }

    addFile(fileId, name, data) {
        const wasOne = this.files.size === 1;
        this.files.set(fileId, { name, data });
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
            if (plot.mode === 'timeseries') {
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

    updateFileData(fileId, newData) {
        const entry = this.files.get(fileId);
        if (!entry) return;
        entry.data = newData;
        // Rebuild every panel that has at least one trace from this file
        for (const [panelId, plot] of this.plots) {
            const uses = plot.traces.some(t => t.fileId === fileId) ||
                         plot.phaseTraces.some(t => t.fileId === fileId);
            if (uses) this._rebuildPanel(panelId);
        }
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

    hasAnyTraces() {
        for (const [, plot] of this.plots) {
            if (plot.traces.length > 0 || plot.phaseTraces.length > 0) return true;
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
    setSyncAxes(v)             { this.syncAxes = v; }
    setLegendPosition(pos)     { this.legendPosition = pos;   this._relayoutAll(); }
    setSyncHover(v)            { this.syncHover = v; if (!v) this._clearHoverMarkers(); }

    resizeAll() {
        for (const [, plot] of this.plots) {
            if (plot.div) Plotly.Plots.resize(plot.div);
        }
    }

    autoZoomAll() {
        for (const [id, plot] of this.plots) {
            if (!plot.div) continue;
            if (this._is3D(plot.mode)) {
                this._setCamera(id, 'home');
            } else {
                Plotly.relayout(plot.div, { 'xaxis.autorange': true, 'yaxis.autorange': true });
            }
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
            this._createChart(panelId, panelEl);
        } else {
            this._updatePlaceholder(panelId, panelEl);
        }
    }

    _unmountPanel(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        if (plot.resizeObserver) { plot.resizeObserver.disconnect(); }
        if (plot.div)            { Plotly.purge(plot.div); }
        this.plots.delete(panelId);  // panel is gone from DOM — remove completely
    }

    // ─── Mode switching ────────────────────────────────────────────

    _setMode(panelId, mode) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode === mode) return;

        // Tear down existing chart
        this._destroyChart(panelId);
        plot.mode         = mode;
        plot.traces       = [];
        plot.phaseTraces  = [];
        plot.phasePending = { x: null, y: null, z: null, fileId: null };

        // Update UI — re-inject all buttons so view labels reflect the new mode
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!panelEl) return;
        const placeholder = panelEl.querySelector('.layout-panel-placeholder');
        if (placeholder) { placeholder.style.display = ''; placeholder.classList.remove('drag-over'); }
        this._injectModeButtons(panelId, panelEl, mode);
        this._updatePlaceholder(panelId, panelEl);
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

        const showDragHint = () => {
            const msg = this._dropMessage(panelId);
            if (hasChart()) {
                // Existing plot: show transparent overlay on top
                overlay.innerHTML = `<span>${msg}</span>`;
                overlay.classList.add('active');
            } else {
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
            showDragHint();
        });

        panelEl.addEventListener('dragleave', (e) => {
            if (panelEl.contains(e.relatedTarget)) return;
            hideDragHint();
        });

        panelEl.addEventListener('drop', (e) => {
            e.preventDefault();
            hideDragHint();
            const varName = e.dataTransfer.getData('text/plain');
            if (varName && this.data) this.addTrace(panelId, varName, panelEl);
        });
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
    _dropMessage(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return i18n.t('dropVariableHere');

        const pp   = plot.phasePending;
        const mode = plot.mode;
        const n    = plot.phaseTraces.length; // completed traces

        // Timeseries: always accept more variables
        if (mode === 'timeseries') {
            return plot.traces.length === 0
                ? i18n.t('dropVariableHere')
                : i18n.t('dropToAddTrace');
        }

        // Phase modes: guide axis by axis
        // When pending is empty, we're starting a new trace
        switch (mode) {
            case 'phase2d':
                return !pp.x ? '① Drop X variable here' : '② Drop Y variable here';
            case 'phase2dt':
                return !pp.x ? '① Drop X variable here' : '② Drop Y variable here (time = automatic)';
            case 'phase3d':
                return !pp.x ? '① Drop X variable here'
                     : !pp.y ? '② Drop Y variable here'
                     :         '③ Drop Z variable here';
        }
        return i18n.t('dropVariableHere');
    }

    // ─── Adding variables ──────────────────────────────────────────

    addTrace(panelId, varName, panelEl) {
        if (!this.data) return;
        const variable = this.data.variables[varName];
        if (!variable || variable.kind === 'abscissa') return;

        if (!this.plots.has(panelId)) {
            this.plots.set(panelId, this._makeState());
        }
        const plot = this.plots.get(panelId);

        if (plot.mode === 'timeseries') {
            this._addTimeseries(panelId, varName, panelEl, plot);
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
        Plotly.deleteTraces(plot.div, idx);
        if (plot.traces.length === 0) this._clearPanel(panelId);
    }

    _addTimeseries(panelId, varName, panelEl, plot) {
        if (plot.traces.find(t => t.varName === varName && t.fileId === this.activeFileId)) return; // deduplicate
        plot.traces.push({ varName, color: this._nextColor(plot.traces.length), fileId: this.activeFileId });

        if (!plot.div) {
            this._createChart(panelId, panelEl);
        } else {
            const t = plot.traces[plot.traces.length - 1];
            Plotly.addTraces(plot.div, this._buildTimeTrace(t));
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
                      (mode === 'phase3d'  && pp.x && pp.y && pp.z);

        if (ready) {
            // Commit pending → completed trace
            const color = this._nextColor(plot.phaseTraces.length);
            plot.phaseTraces.push({ x: pp.x, y: pp.y, z: pp.z || null, color, fileId: pp.fileId });
            plot.phasePending = { x: null, y: null, z: null, fileId: null };

            if (!plot.div) this._createChart(panelId, panelEl);
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

        const placeholder = panelEl.querySelector('.layout-panel-placeholder');
        if (placeholder) placeholder.style.display = 'none';

        const div = document.createElement('div');
        div.className = 'plotly-container';
        panelEl.appendChild(div);
        plot.div = div;

        const { traces, layout } = this._buildPlotData(plot);
        const config = { responsive: true, displayModeBar: true, displaylogo: false, scrollZoom: true };

        Plotly.newPlot(div, traces, layout, config).then(() => {
            this._refreshActionBtns(panelId);
            // Apply home camera for 3D modes (overrides Plotly's default asymmetric view)
            if (this._is3D(plot.mode)) {
                this._setCamera(panelId, 'home');
            }
            // Axis sync, hover sync, and scroll-wheel pan (timeseries only)
            if (plot.mode === 'timeseries') {
                div.on('plotly_relayout', (ed) => this._onRelayout(panelId, ed));
                div.on('plotly_hover',    (ed) => this._onHover(panelId, ed));
                div.on('plotly_unhover',  ()   => this._onUnhover(panelId));
                // Restore default scroll-wheel zoom (Plotly handles this natively via scrollZoom)
                // No custom wheel listener needed.

                // Middle-mouse-button pan: switch dragmode before Plotly sees the mousedown
                div.addEventListener('mousedown', (e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    Plotly.relayout(div, { dragmode: 'pan' });
                    document.addEventListener('mouseup', () => {
                        Plotly.relayout(div, { dragmode: 'zoom' });
                    }, { once: true });
                }, { capture: true });
            }
            // Track legend visibility in our own state so it survives re-renders.
            // We match by trace name, not by curveNumber, because marker traces inserted via
            // Plotly.addTraces shift the indices and make curveNumber unreliable.
            const toggleVisByName = (clickedName) => {
                if (clickedName === '__hover__') return;
                if (plot.mode === 'timeseries') {
                    const t = plot.traces.find(t => t.varName === clickedName);
                    if (t) t.visible = (t.visible === 'legendonly') ? true : 'legendonly';
                } else {
                    const t = plot.phaseTraces.find(pt => {
                        const n = plot.mode === 'phase3d'
                            ? `${pt.x} / ${pt.y} / ${pt.z}`
                            : `${pt.x} vs ${pt.y}`;
                        return n === clickedName;
                    });
                    if (t) t.visible = (t.visible === 'legendonly') ? true : 'legendonly';
                }
            };
            div.on('plotly_legendclick', (ed) => {
                toggleVisByName(ed.data[ed.curveNumber]?.name);
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
            // Pre-allocate marker trace for hover sync on all modes
            this._initMarkerTrace(plot);
            // Resize observer
            let timer;
            const ro = new ResizeObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(() => Plotly.Plots.resize(div), 50);
            });
            ro.observe(panelEl);
            plot.resizeObserver = ro;
        });
    }

    _updatePhaseChart(panelId, plot) {
        if (!plot.div) return;
        // Add only the newest trace — never touches the camera/scene
        const allTraces = this._buildPlotData(plot).traces;
        const newTrace = allTraces[allTraces.length - 1];
        Plotly.addTraces(plot.div, newTrace).then(() => {
            // Add a corresponding marker trace for hover sync
            const panelEl = plot.div.closest('.layout-panel');
            this._addOneMarkerTrace(plot, plot.phaseTraces[plot.phaseTraces.length - 1]);
        });
        // Update legend visibility only (no scene keys → no camera reset)
        const { bg, gridColor, legendBg } = this._colors();
        Plotly.relayout(plot.div, {
            showlegend: true,
            legend: this._legendConfig(legendBg, gridColor),
        });
    }

    _destroyChart(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        if (plot.resizeObserver) { plot.resizeObserver.disconnect(); plot.resizeObserver = null; }
        if (plot.div)            { Plotly.purge(plot.div); plot.div.remove(); plot.div = null; }
    }

    _clearPanel(panelId) {
        this._destroyChart(panelId);

        // Reset state to empty timeseries (keep panel alive with fresh state)
        const existing = this.plots.get(panelId);
        if (existing) {
            existing.traces        = [];
            existing.phaseTraces   = [];
            existing.phasePending  = { x: null, y: null, z: null };
            existing.markerTraceIdx = null;
            // keep existing.mode so the user's mode choice is preserved
        }

        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (panelEl) {
            const placeholder = panelEl.querySelector('.layout-panel-placeholder');
            if (placeholder) { placeholder.style.display = ''; placeholder.classList.remove('drag-over'); }
            this._setPendingOverlay(panelId, panelEl, false);
            this._updatePlaceholder(panelId, panelEl);
        }
        this._refreshActionBtns(panelId);
    }

    _refreshActionBtns(panelId) {
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!panelEl) return;
        const plot = this.plots.get(panelId);
        const has = this._hasContent(plot);
        const csvBtn = panelEl.querySelector('.csv-export-btn');
        if (csvBtn) csvBtn.disabled = !has;
        // 🗑️ has no disabled state — always clickable
    }

    _exportCSV(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot || !this._hasContent(plot)) return;

        const headers = [];
        const columns = [];

        if (plot.mode === 'timeseries') {
            // Use first trace's file for the time column
            const firstFid = plot.traces[0]?.fileId;
            const timeVar  = this._getTimeVar(firstFid);
            const times    = timeVar?.data ?? [];
            const timeUnit = timeVar ? this._extractUnit(timeVar.description) : 's';
            headers.push(`time [${timeUnit}]`);
            columns.push(times);
            for (const t of plot.traces) {
                const d = this.files.get(t.fileId)?.data;
                const v = d?.variables[t.varName];
                if (!v) continue;
                const u    = this._extractUnit(v.description);
                const name = this._traceName(t.varName, t.fileId);
                headers.push(u ? `${name} [${u}]` : name);
                columns.push(v.kind === 'parameter' ? Array.from(times).map(() => v.data[0]) : Array.from(v.data));
            }
        } else if (plot.mode === 'phase2dt') {
            const firstFid = plot.phaseTraces[0]?.fileId;
            const timeVar  = this._getTimeVar(firstFid);
            const times    = timeVar?.data ?? [];
            const timeUnit = timeVar ? this._extractUnit(timeVar.description) : 's';
            headers.push(`time [${timeUnit}]`);
            columns.push(times);
            for (const pt of plot.phaseTraces) {
                const d = this.files.get(pt.fileId)?.data;
                if (!d) continue;
                const xv = d.variables[pt.x], yv = d.variables[pt.y];
                if (!xv || !yv) continue;
                const xu = this._extractUnit(xv.description), yu = this._extractUnit(yv.description);
                const nx = this._traceName(pt.x, pt.fileId), ny = this._traceName(pt.y, pt.fileId);
                headers.push(xu ? `${nx} [${xu}]` : nx);
                headers.push(yu ? `${ny} [${yu}]` : ny);
                columns.push(Array.from(xv.data));
                columns.push(Array.from(yv.data));
            }
        } else if (plot.mode === 'phase2d') {
            for (const pt of plot.phaseTraces) {
                const d = this.files.get(pt.fileId)?.data;
                if (!d) continue;
                const xv = d.variables[pt.x], yv = d.variables[pt.y];
                if (!xv || !yv) continue;
                const xu = this._extractUnit(xv.description), yu = this._extractUnit(yv.description);
                const nx = this._traceName(pt.x, pt.fileId), ny = this._traceName(pt.y, pt.fileId);
                headers.push(xu ? `${nx} [${xu}]` : nx);
                headers.push(yu ? `${ny} [${yu}]` : ny);
                columns.push(Array.from(xv.data));
                columns.push(Array.from(yv.data));
            }
        } else if (plot.mode === 'phase3d') {
            for (const pt of plot.phaseTraces) {
                const d = this.files.get(pt.fileId)?.data;
                if (!d) continue;
                const xv = d.variables[pt.x], yv = d.variables[pt.y], zv = d.variables[pt.z];
                if (!xv || !yv || !zv) continue;
                const xu = this._extractUnit(xv.description), yu = this._extractUnit(yv.description), zu = this._extractUnit(zv.description);
                const nx = this._traceName(pt.x, pt.fileId), ny = this._traceName(pt.y, pt.fileId), nz = this._traceName(pt.z, pt.fileId);
                headers.push(xu ? `${nx} [${xu}]` : nx);
                headers.push(yu ? `${ny} [${yu}]` : ny);
                headers.push(zu ? `${nz} [${zu}]` : nz);
                columns.push(Array.from(xv.data));
                columns.push(Array.from(yv.data));
                columns.push(Array.from(zv.data));
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

    // ─── Trace / layout builders ───────────────────────────────────

    _buildPlotData(plot) {
        switch (plot.mode) {
            case 'phase2d':  return { traces: this._buildPhase2DTraces(plot),  layout: this._buildPhase2DLayout(plot)  };
            case 'phase2dt': return { traces: this._buildPhase2DtTraces(plot), layout: this._buildPhase3DLayout(plot, true)  };
            case 'phase3d':  return { traces: this._buildPhase3DTraces(plot),  layout: this._buildPhase3DLayout(plot, false) };
            default:         return { traces: plot.traces.map(t => this._buildTimeTrace(t)).filter(Boolean), layout: this._buildTimeLayout(plot) };
        }
    }

    // ── Timeseries ──
    _buildTimeTrace(t) {
        const fileData = this.files.get(t.fileId)?.data;
        if (!fileData) return null;
        const variable = fileData.variables[t.varName];
        if (!variable) return null;
        const timeVar  = this._getTimeVar(t.fileId);
        const timeUnit = timeVar ? this._extractUnit(timeVar.description) : 's';
        const unit     = this._extractUnit(variable.description);
        const unitStr  = unit ? ` [${unit}]` : '';
        const name     = this._traceName(t.varName, t.fileId);

        if (variable.kind === 'parameter') {
            const tStart = timeVar ? timeVar.data[0]                       : 0;
            const tEnd   = timeVar ? timeVar.data[timeVar.data.length - 1] : 1;
            return {
                x: [tStart, tEnd], y: [variable.data[0], variable.data[0]],
                name, type: 'scatter', mode: 'lines',
                visible: t.visible ?? true,
                line: { color: t.color, width: 1.5, dash: 'dash' },
                hovertemplate: `<b>Time [${timeUnit}]</b> = %{x:.4g}<br><b>${name}</b>${unitStr} = ${variable.data[0]}<extra></extra>`,
            };
        }
        const isStep = variable.dataType === 'boolean' || variable.dataType === 'integer';
        return {
            x: timeVar ? timeVar.data : [], y: variable.data,
            name, type: 'scatter', mode: 'lines',
            visible: t.visible ?? true,
            line: { color: t.color, width: 1.5, shape: isStep ? 'hv' : 'linear' },
            hovertemplate: `<b>Time [${timeUnit}]</b> = %{x:.4g}<br><b>${name}</b>${unitStr} = %{y:.4g}<extra></extra>`,
        };
    }

    _buildTimeLayout(plot) {
        const { bg, gridColor, fontColor, legendBg } = this._colors();
        const firstTrace = plot.traces[0];
        const timeVar  = firstTrace ? this._getTimeVar(firstTrace.fileId) : this._getTimeVar();
        const timeUnit = timeVar ? this._extractUnit(timeVar.description) : 's';
        const units    = [...new Set(plot.traces.map(t => {
            const d = this.files.get(t.fileId)?.data;
            const v = d?.variables[t.varName];
            return v ? this._extractUnit(v.description) : '';
        }).filter(Boolean))];
        const yTitle = units.length === 1 ? units[0] : '';

        return {
            paper_bgcolor: bg, plot_bgcolor: bg,
            font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
            showlegend: true,
            xaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                     title: { text: `Time [${timeUnit}]`, font: { size: 10 } } },
            yaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                     title: yTitle ? { text: yTitle, font: { size: 10 } } : undefined },
            legend: this._legendConfig(legendBg, gridColor),
            margin:    this._marginConfig(),
            autosize:  true,
            hovermode: 'x',
        };
    }

    // ── Phase 2D ──
    _buildPhase2DTraces(plot) {
        return plot.phaseTraces.map(pt => {
            const d = this.files.get(pt.fileId)?.data;
            if (!d) return null;
            const xVar = d.variables[pt.x], yVar = d.variables[pt.y];
            if (!xVar || !yVar) return null;
            return {
                x: xVar.data, y: yVar.data,
                name: this._traceName(`${pt.x} vs ${pt.y}`, pt.fileId),
                type: 'scatter', mode: 'lines',
                visible: pt.visible ?? true,
                line: { color: pt.color, width: 1.5 },
            };
        }).filter(Boolean);
    }

    _buildPhase2DLayout(plot) {
        const { bg, gridColor, fontColor, legendBg } = this._colors();
        const first = plot.phaseTraces[0] || {};
        const xu = this._varUnit(first.x, first.fileId);
        const yu = this._varUnit(first.y, first.fileId);
        return {
            paper_bgcolor: bg, plot_bgcolor: bg,
            font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
            showlegend: true,
            legend: this._legendConfig(legendBg, gridColor),
            xaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                     title: { text: xu ? `${first.x} [${xu}]` : (first.x || 'X'), font: { size: 10 } } },
            yaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                     title: { text: yu ? `${first.y} [${yu}]` : (first.y || 'Y'), font: { size: 10 } } },
            margin: { l: 60, r: 15, t: 10, b: 50 },
            autosize: true, hovermode: 'closest',
        };
    }

    // ── Phase 2D+t: x=var1, y=time, z=var2 ──
    _buildPhase2DtTraces(plot) {
        return plot.phaseTraces.map(pt => {
            const d = this.files.get(pt.fileId)?.data;
            if (!d) return null;
            const xVar = d.variables[pt.x], yVar = d.variables[pt.y];
            const timeVar = this._getTimeVar(pt.fileId);
            if (!xVar || !yVar) return null;
            return {
                x: xVar.data, y: timeVar ? timeVar.data : [], z: yVar.data,
                name: this._traceName(`${pt.x} vs ${pt.y}`, pt.fileId),
                type: 'scatter3d', mode: 'lines',
                visible: pt.visible ?? true,
                line: { color: pt.color, width: 3 },
            };
        }).filter(Boolean);
    }

    // ── Phase 3D ──
    _buildPhase3DTraces(plot) {
        return plot.phaseTraces.map(pt => {
            const d = this.files.get(pt.fileId)?.data;
            if (!d) return null;
            const xVar = d.variables[pt.x], yVar = d.variables[pt.y], zVar = d.variables[pt.z];
            if (!xVar || !yVar || !zVar) return null;
            return {
                x: xVar.data, y: yVar.data, z: zVar.data,
                name: this._traceName(`${pt.x} / ${pt.y} / ${pt.z}`, pt.fileId),
                type: 'scatter3d', mode: 'lines',
                visible: pt.visible ?? true,
                line: { color: pt.color, width: 3 },
            };
        }).filter(Boolean);
    }

    _buildPhase3DLayout(plot, isTimez) {
        const { bg, gridColor, fontColor, legendBg } = this._colors();
        const first = plot.phaseTraces[0] || {};
        const xu = this._varUnit(first.x, first.fileId);
        const timeVar  = this._getTimeVar(first.fileId);
        const timeUnit = timeVar ? this._extractUnit(timeVar.description) : 's';

        // phase2dt: plotly X=var1, Y=time, Z=var2
        // phase3d:  plotly X=var1, Y=var2, Z=var3
        let xLabel, yLabel, zLabel;
        if (isTimez) {
            const zu = this._varUnit(first.y, first.fileId);
            xLabel = xu ? `${first.x} [${xu}]` : (first.x || 'X');
            yLabel = `Time [${timeUnit}]`;
            zLabel = zu ? `${first.y} [${zu}]` : (first.y || 'Z');
        } else {
            const yu = this._varUnit(first.y, first.fileId);
            const zu = this._varUnit(first.z, first.fileId);
            xLabel = xu ? `${first.x} [${xu}]` : (first.x || 'X');
            yLabel = yu ? `${first.y} [${yu}]` : (first.y || 'Y');
            zLabel = zu ? `${first.z} [${zu}]` : (first.z || 'Z');
        }

        const axisStyle = { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor,
                            backgroundcolor: bg, showbackground: true, zeroline: false };
        return {
            paper_bgcolor: bg,
            font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
            showlegend: true,
            legend: this._legendConfig(legendBg, gridColor),
            scene: {
                xaxis: { ...axisStyle, title: { text: xLabel } },
                yaxis: { ...axisStyle, title: { text: yLabel } },
                zaxis: { ...axisStyle, title: { text: zLabel } },
                camera: { projection: { type: plot.projection || 'orthographic' } },
                bgcolor: bg,
            },
            margin:   { l: 0, r: 0, t: 10, b: 0 },
            autosize: true,
        };
    }

    // ─── Axis sync (timeseries only) ───────────────────────────────

    _onRelayout(sourcePanelId, eventData) {
        if (!this.syncAxes || this._syncing) return;
        const hasRange     = eventData['xaxis.range[0]'] !== undefined;
        const hasAutorange = eventData['xaxis.autorange'] === true;
        if (!hasRange && !hasAutorange) return;

        const update = hasAutorange
            ? { 'xaxis.autorange': true }
            : { 'xaxis.range[0]': eventData['xaxis.range[0]'], 'xaxis.range[1]': eventData['xaxis.range[1]'] };

        const targets = [];
        for (const [id, plot] of this.plots) {
            if (id !== sourcePanelId && plot.div && plot.mode === 'timeseries') targets.push(plot.div);
        }
        if (targets.length === 0) return;

        this._syncing = true;
        Promise.all(targets.map(div => Plotly.relayout(div, update)))
            .finally(() => { this._syncing = false; });
    }

    // ─── Synchronized hover ────────────────────────────────────────

    _onHover(sourcePanelId, eventData) {
        if (!this.syncHover || this._hovering) return;
        const pt = eventData.points?.[0];
        if (pt == null) return;
        const xVal = pt.x;   // hovered time value

        this._hovering = true;

        // Time unit from source panel's first trace
        const srcPlot    = this.plots.get(sourcePanelId);
        const srcFid     = srcPlot?.traces?.[0]?.fileId ?? this.activeFileId;
        const srcTimeVar = this._getTimeVar(srcFid);
        const timeUnit   = srcTimeVar ? this._extractUnit(srcTimeVar.description) : 's';

        for (const [, plot] of this.plots) {
            if (!plot.div) continue;
            const panelEl = plot.div.closest('.layout-panel');

            if (plot.mode === 'timeseries') {
                Plotly.relayout(plot.div, {
                    shapes: [{
                        type: 'line', xref: 'x', yref: 'paper',
                        x0: xVal, x1: xVal, y0: 0, y1: 1,
                        line: { color: 'rgba(120,120,120,0.6)', width: 1, dash: 'dot' },
                    }]
                });
                if (plot.markerTraceIdx != null) {
                    const xs = [], ys = [];
                    plot.traces.forEach(t => {
                        const hidden  = t.visible === 'legendonly' || t.visible === false;
                        const d       = this.files.get(t.fileId)?.data;
                        const v       = d?.variables[t.varName];
                        const tvar    = this._getTimeVar(t.fileId);
                        const tidx    = this._findTimeIdx(tvar?.data, xVal);
                        if (!hidden && v && v.kind !== 'parameter' && v.data) { xs.push(xVal); ys.push(v.data[tidx]); }
                        else { xs.push(null); ys.push(null); }
                    });
                    Plotly.restyle(plot.div, { x: [xs], y: [ys], visible: true }, [plot.markerTraceIdx]);
                }
                const lines = [`<b>t = ${xVal.toPrecision(5)} ${timeUnit}</b>`];
                plot.traces.forEach(t => {
                    if (t.visible === 'legendonly' || t.visible === false) return;
                    const d    = this.files.get(t.fileId)?.data;
                    const v    = d?.variables[t.varName];
                    const tvar = this._getTimeVar(t.fileId);
                    const tidx = this._findTimeIdx(tvar?.data, xVal);
                    if (v && v.kind !== 'parameter' && v.data) {
                        const unit  = this._extractUnit(v.description);
                        const label = this._traceName(t.varName, t.fileId);
                        lines.push(`<span style="color:${t.color}">●</span> ${label} = ${v.data[tidx].toPrecision(5)}${unit ? ' ' + unit : ''}`);
                    }
                });
                this._showInfoBox(panelEl, lines.join('<br>'));

            } else if (plot.mode === 'phase2d') {
                if (plot.markerTraceIdx != null) {
                    plot.phaseTraces.forEach((pt2, i) => {
                        const hidden = pt2.visible === 'legendonly' || pt2.visible === false;
                        const d = this.files.get(pt2.fileId)?.data;
                        if (!d) return;
                        const xv = d.variables[pt2.x], yv = d.variables[pt2.y];
                        if (!xv || !yv) return;
                        const tvar = this._getTimeVar(pt2.fileId);
                        const tidx = this._findTimeIdx(tvar?.data, xVal);
                        const midx = Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx[i] : plot.markerTraceIdx;
                        if (hidden) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
                        Plotly.restyle(plot.div, { x: [[xv.data[tidx]]], y: [[yv.data[tidx]]], visible: true }, [midx]);
                    });
                }
                const lines = [`<b>t = ${xVal.toPrecision(5)} ${timeUnit}</b>`];
                plot.phaseTraces.forEach(pt2 => {
                    if (pt2.visible === 'legendonly' || pt2.visible === false) return;
                    const d = this.files.get(pt2.fileId)?.data;
                    if (!d) return;
                    const xv = d.variables[pt2.x], yv = d.variables[pt2.y];
                    if (xv && yv) {
                        const tvar = this._getTimeVar(pt2.fileId);
                        const tidx = this._findTimeIdx(tvar?.data, xVal);
                        const xu = this._extractUnit(xv.description), yu = this._extractUnit(yv.description);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${pt2.x} = ${xv.data[tidx].toPrecision(5)}${xu ? ' ' + xu : ''}`);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${pt2.y} = ${yv.data[tidx].toPrecision(5)}${yu ? ' ' + yu : ''}`);
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
                        const tvar = this._getTimeVar(pt2.fileId);
                        const tidx = this._findTimeIdx(tvar?.data, xVal);
                        const midx = Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx[i] : plot.markerTraceIdx;
                        if (hidden) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
                        Plotly.restyle(plot.div, { x: [[xv.data[tidx]]], y: [[xVal]], z: [[yv.data[tidx]]], visible: true }, [midx]);
                    });
                }
                const lines = [`<b>t = ${xVal.toPrecision(5)} ${timeUnit}</b>`];
                plot.phaseTraces.forEach(pt2 => {
                    if (pt2.visible === 'legendonly' || pt2.visible === false) return;
                    const d = this.files.get(pt2.fileId)?.data;
                    if (!d) return;
                    const xv = d.variables[pt2.x], yv = d.variables[pt2.y];
                    if (xv && yv) {
                        const tvar = this._getTimeVar(pt2.fileId);
                        const tidx = this._findTimeIdx(tvar?.data, xVal);
                        const xu = this._extractUnit(xv.description), zu = this._extractUnit(yv.description);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${pt2.x} = ${xv.data[tidx].toPrecision(5)}${xu ? ' ' + xu : ''}`);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${pt2.y} = ${yv.data[tidx].toPrecision(5)}${zu ? ' ' + zu : ''}`);
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
                        const tvar = this._getTimeVar(pt2.fileId);
                        const tidx = this._findTimeIdx(tvar?.data, xVal);
                        const midx = Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx[i] : plot.markerTraceIdx;
                        if (hidden) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
                        Plotly.restyle(plot.div, { x: [[xv.data[tidx]]], y: [[yv.data[tidx]]], z: [[zv.data[tidx]]], visible: true }, [midx]);
                    });
                }
                const lines = [`<b>t = ${xVal.toPrecision(5)} ${timeUnit}</b>`];
                plot.phaseTraces.forEach(pt2 => {
                    if (pt2.visible === 'legendonly' || pt2.visible === false) return;
                    const d = this.files.get(pt2.fileId)?.data;
                    if (!d) return;
                    const xv = d.variables[pt2.x], yv = d.variables[pt2.y], zv = d.variables[pt2.z];
                    if (xv && yv && zv) {
                        const tvar = this._getTimeVar(pt2.fileId);
                        const tidx = this._findTimeIdx(tvar?.data, xVal);
                        [xv, yv, zv].forEach((v, vi) => {
                            const name = [pt2.x, pt2.y, pt2.z][vi];
                            const u = this._extractUnit(v.description);
                            lines.push(`<span style="color:${pt2.color}">●</span> ${name} = ${v.data[tidx].toPrecision(5)}${u ? ' ' + u : ''}`);
                        });
                    }
                });
                this._showInfoBox(panelEl, lines.join('<br>'));
            }
        }

        this._hovering = false;
    }

    _onUnhover(sourcePanelId) {
        if (!this.syncHover) return;
        this._clearHoverMarkers();
    }

    _clearHoverMarkers() {
        for (const [, plot] of this.plots) {
            if (!plot.div) continue;
            const panelEl = plot.div.closest('.layout-panel');
            this._hideInfoBox(panelEl);
            if (plot.mode === 'timeseries') {
                Plotly.relayout(plot.div, { shapes: [] });
            }
            if (plot.markerTraceIdx != null) {
                const idxList = Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx : [plot.markerTraceIdx];
                idxList.forEach(i => {
                    const is3d = plot.mode === 'phase2dt' || plot.mode === 'phase3d';
                    const upd = is3d ? { x: [[null]], y: [[null]], z: [[null]], visible: false }
                                    : { x: [[null]], y: [[null]], visible: false };
                    Plotly.restyle(plot.div, upd, [i]);
                });
            }
        }
    }

    _showInfoBox(panelEl, html) {
        if (!panelEl) return;
        let box = panelEl.querySelector('.hover-info-box');
        if (!box) {
            box = document.createElement('div');
            box.className = 'hover-info-box';
            panelEl.appendChild(box);
        }
        box.innerHTML = html;
        box.style.display = 'block';
    }

    _hideInfoBox(panelEl) {
        if (!panelEl) return;
        const box = panelEl.querySelector('.hover-info-box');
        if (box) box.style.display = 'none';
    }

    /** Add hidden marker trace(s) for hover sync. Called once after newPlot. */
    _initMarkerTrace(plot) {
        if (!plot.div) return;

        if (plot.mode === 'timeseries') {
            const markerTrace = {
                x: [null], y: [null], type: 'scatter', mode: 'markers',
                marker: { size: 9, color: plot.traces.map(t => t.color), line: { color: '#fff', width: 1.5 } },
                showlegend: false, hoverinfo: 'skip', visible: false, name: '__hover__',
            };
            Plotly.addTraces(plot.div, markerTrace).then(() => {
                plot.markerTraceIdx = plot.div.data.length - 1;
            });
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
    }

    _addOneMarkerTrace(plot, pt) {
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
    }

    // ─── 3D camera views ───────────────────────────────────────────

    _setCamera(panelId, preset) {
        const plot = this.plots.get(panelId);
        if (!plot?.div) return;
        // Plotly's own default is eye=(1.25,1.25,1.25), up=(0,0,1)
        const is2dt = plot.mode === 'phase2dt';
        const cameras = {
            home:  { eye: { x: 1.25, y: 1.25, z: 1.25 }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
            // top/Xt: looking down Z axis.
            // phase3d: up=Y → X right, Y up (XY plane)
            // phase2dt: up=X → Y(time) right, X(var1) up (tX / "Xt" view)
            top:   is2dt
                ? { eye: { x: 0, y: 0, z: 2 }, center: { x: 0, y: 0, z: 0 }, up: { x: 1, y: 0, z: 0 } }
                : { eye: { x: 0, y: 0, z: 2 }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } },
            front: { eye: { x: 0,    y: -2,   z: 0    }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
            yz:    { eye: { x: 2,    y: 0,    z: 0    }, center: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
        };
        const cam = cameras[preset] || cameras.home;
        Plotly.relayout(plot.div, {
            'scene.camera': { ...cam, projection: { type: plot.projection || 'orthographic' } },
        });
    }

    _toggleProjection(panelId, panelEl) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        plot.projection = plot.projection === 'orthographic' ? 'perspective' : 'orthographic';
        if (plot.div) {
            Plotly.relayout(plot.div, { 'scene.camera.projection.type': plot.projection });
        }
        const projBtn = panelEl.querySelector('.proj-btn');
        if (projBtn) {
            const isOrtho = plot.projection === 'orthographic';
            projBtn.classList.toggle('active', isOrtho);
            projBtn.title = i18n.t(isOrtho ? 'projIsometric' : 'projPerspective');
        }
    }

    // ─── Mode buttons injected into panel toolbar ──────────────────

    _injectModeButtons(panelId, panelEl, currentMode) {
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
            { id: 'phase3d',    label: '3D',  titleKey: 'modePhase3d'   },
        ];
        modes.forEach(m => {
            const btn = document.createElement('button');
            btn.className = 'layout-toolbar-btn mode-btn' + (m.id === currentMode ? ' active' : '');
            btn.textContent = m.label;
            btn.title = i18n.t(m.titleKey);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._setMode(panelId, m.id);
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
            { preset: 'top',   label: is2dt ? 'Xt' : 'XY', titleKey: 'viewTop'   },
            { preset: 'front', label: is2dt ? 'XY' : 'XZ',  titleKey: 'viewFront' },
            { preset: 'yz',    label: is2dt ? 'Yt' : 'YZ', titleKey: 'viewSide'  },
        ];

        views.forEach(v => {
            const btn = document.createElement('button');
            btn.className = 'layout-toolbar-btn view-btn';
            btn.textContent = v.label;
            btn.title = i18n.t(v.titleKey);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._setCamera(panelId, v.preset === 'yz' ? 'yz' : v.preset);
            });
            viewGroup.appendChild(btn);
        });

        // Projection toggle button (Iso / Persp)
        const isOrtho = !plot || plot.projection === 'orthographic';
        const projBtn = document.createElement('button');
        projBtn.className = 'layout-toolbar-btn view-btn proj-btn' + (isOrtho ? ' active' : '');
        projBtn.textContent = 'Iso';
        projBtn.title = i18n.t(isOrtho ? 'projIsometric' : 'projPerspective');
        projBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleProjection(panelId, panelEl);
        });
        viewGroup.appendChild(projBtn);

        toolbar.appendChild(viewGroup);

        // CSV export button — pushed to far right, 🗑️ follows immediately after
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
    }

    _updateModeButtons(panelEl, activeMode) {
        panelEl.querySelectorAll('.mode-btn').forEach(btn => {
            const modeMap = { '📈': 'timeseries', '2D': 'phase2d', '2D+t': 'phase2dt', '3D': 'phase3d' };
            btn.classList.toggle('active', modeMap[btn.textContent] === activeMode);
        });
    }

    _toggle3DViewButtons(panelEl, show) {
        const group = panelEl.querySelector('.view-btn-group');
        if (group) group.style.display = show ? '' : 'none';
    }

    // ─── Placeholder text ──────────────────────────────────────────

    _updatePlaceholder(panelId, panelEl) {
        const placeholder = panelEl.querySelector('.layout-panel-placeholder');
        if (!placeholder) return;

        const plot = this.plots.get(panelId);
        // If plot has content, placeholder is hidden — nothing to update
        if (plot && this._hasContent(plot)) return;

        const mode = plot ? plot.mode : 'timeseries';
        const pp   = plot ? plot.phasePending : { x: null, y: null, z: null };

        let msg;
        switch (mode) {
            case 'phase2d':
                msg = !pp.x
                    ? '① Drop X variable here'
                    : '② Drop Y variable here';
                break;
            case 'phase2dt':
                msg = !pp.x
                    ? '① Drop X variable here'
                    : '② Drop Y variable here (time = automatic)';
                break;
            case 'phase3d':
                msg = !pp.x ? '① Drop X variable here'
                    : !pp.y ? '② Drop Y variable here'
                    :         '③ Drop Z variable here';
                break;
            default: // timeseries
                msg = i18n.t('dropVariableHere');
        }
        placeholder.innerHTML = `<span>${msg}</span>`;
    }

    // ─── Helpers ───────────────────────────────────────────────────

    _relayoutAll() {
        if (!this.data) return;
        for (const [, plot] of this.plots) {
            if (!plot.div) continue;
            if (this._is3D(plot.mode)) {
                // Build the new layout but preserve the current camera
                const layout = this._buildPlotData(plot).layout;
                const currentCamera = plot.div._fullLayout?.scene?.camera;
                if (currentCamera) layout.scene.camera = currentCamera;
                Plotly.relayout(plot.div, layout);
            } else {
                Plotly.relayout(plot.div, this._buildPlotData(plot).layout);
            }
        }
    }

    _hasContent(plot) {
        if (!plot) return false;
        if (plot.mode === 'timeseries') return plot.traces.length > 0;
        return plot.phaseTraces.length > 0;
    }

    _is3D(mode) { return mode === 'phase2dt' || mode === 'phase3d'; }

    _rebuildPanel(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!panelEl) return;
        this._destroyChart(panelId);
        plot.markerTraceIdx = null;
        if (this._hasContent(plot)) {
            this._createChart(panelId, panelEl);
        } else {
            const ph = panelEl.querySelector('.layout-panel-placeholder');
            if (ph) { ph.style.display = ''; ph.classList.remove('drag-over'); }
            this._setPendingOverlay(panelId, panelEl, false);
            this._updatePlaceholder(panelId, panelEl);
            this._refreshActionBtns(panelId);
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
            resizeObserver: null,
        };
    }

    _getTimeVar(fileId = this.activeFileId) {
        const d = fileId ? this.files.get(fileId)?.data : null;
        if (!d) return null;
        return Object.values(d.variables).find(v => v.kind === 'abscissa') || null;
    }

    _varUnit(varName, fileId = this.activeFileId) {
        if (!varName) return '';
        const d = fileId ? this.files.get(fileId)?.data : null;
        if (!d) return '';
        const v = d.variables[varName];
        return v ? this._extractUnit(v.description) : '';
    }

    _traceName(label, fileId) {
        if (this.files.size >= 2 && fileId) {
            const f = this.files.get(fileId);
            if (f) return `${label} [${f.name}]`;
        }
        return label;
    }

    _findTimeIdx(times, xVal) {
        if (!times || !times.length) return 0;
        let idx = 0, minDist = Infinity;
        for (let i = 0; i < times.length; i++) {
            const d = Math.abs(times[i] - xVal);
            if (d < minDist) { minDist = d; idx = i; }
        }
        return idx;
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
            default:        return { ...base, x: 0.01, y: 0.99, xanchor: 'left', yanchor: 'top' };
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

    _nextColor(idx) { return PlotManager.COLORS[idx % PlotManager.COLORS.length]; }
}
