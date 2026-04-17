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
        this.syncAxes       = true;
        this.legendPosition = 'overlay';
        this._syncing       = false;
        this.syncHover      = false;
        this.hoverProximity = true;
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
    setSyncHover(v) {
        this.syncHover = v;
        document.body.classList.toggle('sync-hover-active', v);
        if (!v) this._clearHoverMarkers();
    }
    setHoverProximity(v) {
        this.hoverProximity = v;
        this._relayoutAll();
    }

    resizeAll() {
        for (const [, plot] of this.plots) {
            if (plot.div) Plotly.Plots.resize(plot.div);
        }
    }

    autoZoomAll() {
        for (const [id, plot] of this.plots) {
            if (!plot.div) continue;
            if (this._is3D(plot.mode) || this._isStateAnim3D(plot)) {
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
        this._stopAnim(plot);
        if (plot.resizeObserver) { plot.resizeObserver.disconnect(); }
        if (plot.div)            { Plotly.purge(plot.div); }
        this.plots.delete(panelId);  // panel is gone from DOM — remove completely
    }

    // ─── Mode switching ────────────────────────────────────────────

    _setMode(panelId, mode, stateAnimDim = null) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const nextDim = mode === 'state-anim' ? (stateAnimDim || plot.stateAnimDim || 2) : plot.stateAnimDim;
        if (plot.mode === mode && plot.stateAnimDim === nextDim) return;

        // Stop animation if running
        this._stopAnim(plot);

        // Tear down existing chart
        this._destroyChart(panelId);
        plot.mode         = mode;
        plot.stateAnimDim = nextDim;
        plot.traces       = [];
        plot.phaseTraces  = [];
        plot.phasePending = { x: null, y: null, z: null, fileId: null };
        plot.stateSlots   = { x: [], dx: [], fileId: null };
        plot.equalAspect2D = false;
        plot.animFrame    = 0;

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
            const varNames = this._getDroppedVariableNames(e.dataTransfer);
            if (!varNames.length || !this.data) return;
            if (varNames.length > 1) {
                this._addDroppedVariables(panelId, varNames, panelEl);
            } else {
                this.addTrace(panelId, varNames[0], panelEl);
            }
        });
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

    _addDroppedVariables(panelId, varNames, panelEl) {
        if (!this.plots.has(panelId)) this.plots.set(panelId, this._makeState());
        const plot = this.plots.get(panelId);
        const names = varNames.filter(varName => {
            const variable = this.data?.variables?.[varName];
            return variable && variable.kind !== 'abscissa';
        });
        if (!names.length) return;

        if (plot.mode === 'timeseries') {
            names.forEach(varName => this.addTrace(panelId, varName, panelEl));
            return;
        }

        if (plot.mode === 'phase2d' || plot.mode === 'phase2dt' || plot.mode === 'phase3d') {
            const groupSize = plot.mode === 'phase3d' ? 3 : 2;
            plot.phasePending = { x: null, y: null, z: null, fileId: null };
            let added = 0;
            for (let i = 0; i + groupSize - 1 < names.length; i += groupSize) {
                plot.phaseTraces.push({
                    x: names[i],
                    y: names[i + 1],
                    z: groupSize === 3 ? names[i + 2] : null,
                    color: this._nextColor(plot.phaseTraces.length),
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
    _dropMessage(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return i18n.t('dropVariableHere');

        const pp   = plot.phasePending;
        const mode = plot.mode;
        const n    = plot.phaseTraces.length; // completed traces

        // Timeseries: always accept more variables
        if (mode === 'timeseries') {
            return plot.traces.length === 0
                ? i18n.t('dropTimeseriesMulti')
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
            Plotly.addTraces(plot.div, this._buildTimeTrace(t)).then(() => this._installLegendHoverHint(plot.div));
            // Update Y axis title: clear when 2+ traces (X/time label always stays)
            const layout = this._buildTimeLayout(plot);
            Plotly.relayout(plot.div, { 'yaxis.title': layout.yaxis.title });
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
        div.className = `plotly-container plotly-mode-${plot.mode}`;
        panelEl.appendChild(div);
        plot.div = div;

        const { traces, layout } = this._buildPlotData(plot);
        const config = { responsive: true, displayModeBar: true, displaylogo: false, scrollZoom: true };

        Plotly.newPlot(div, traces, layout, config).then(() => {
            this._refreshActionBtns(panelId);
            // Apply home camera and axis decorations for 3D modes
            if (this._is3D(plot.mode)) {
                this._setCamera(panelId, 'home');
                this._add3DAxisDecorations(plot);
            }
            // Axis sync, hover sync, and scroll-wheel pan (timeseries only)
            if (plot.mode === 'timeseries') {
                div.on('plotly_relayout', (ed) => this._onRelayout(panelId, ed));
                div.on('plotly_hover',    (ed) => this._onHover(panelId, ed));
                div.on('plotly_unhover',  ()   => this._onUnhover(panelId));
            }
            // Pan gestures for 2D plots:
            //   Middle-click: toggle Plotly's native pan dragmode (works with button 1).
            //   Right-click:  custom pan — Plotly's drag only reacts to button 0, so we
            //                 manipulate axis ranges directly on mousemove.
            if (plot.mode === 'timeseries' || plot.mode === 'phase2d') {
                div.addEventListener('mousedown', (e) => {
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
                    const xLen = xa._length, yLen = ya._length;
                    const onMove = (mv) => {
                        const xSpan = x0[1] - x0[0];
                        const ySpan = y0[1] - y0[0];
                        const dx = -((mv.clientX - startX) / xLen) * xSpan;
                        const dy =  ((mv.clientY - startY) / yLen) * ySpan;
                        Plotly.relayout(div, {
                            'xaxis.range': [x0[0] + dx, x0[1] + dx],
                            'yaxis.range': [y0[0] + dy, y0[1] + dy],
                        });
                    };
                    const onUp = () => {
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                    };
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                }, { capture: true });
                div.addEventListener('contextmenu', (e) => e.preventDefault());
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
            div.on('plotly_afterplot', () => this._installLegendHoverHint(div));
            this._installLegendHoverHint(div);
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

    _destroyChart(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        this._stopAnim(plot);
        if (plot.resizeObserver) { plot.resizeObserver.disconnect(); plot.resizeObserver = null; }
        // Reset dynamic trace indices
        delete plot._arrowXIdx;
        delete plot._arrowDxIdx;
        delete plot._xAbsMax;
        delete plot._yAbsMax;
        if (plot.div) {
            // Remove state-anim container if present (wraps the plot div)
            const saContainer = plot.div.closest('.state-anim-container');
            if (saContainer) { Plotly.purge(plot.div); saContainer.remove(); }
            else { Plotly.purge(plot.div); plot.div.remove(); }
            plot.div = null;
        }
        plot.cameraOverlayEl = null;
    }

    _clearPanel(panelId) {
        const existing = this.plots.get(panelId);
        if (existing) this._stopAnim(existing);
        this._destroyChart(panelId);

        // Reset state to empty (keep panel alive with fresh state)
        if (existing) {
            existing.traces        = [];
            existing.phaseTraces   = [];
            existing.phasePending  = { x: null, y: null, z: null };
            existing.markerTraceIdx = null;
            existing.stateSlots    = { x: [], dx: [], fileId: null };
            existing.equalAspect2D = false;
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
        const statsBtn = panelEl.querySelector('.panel-stats-btn');
        if (statsBtn) statsBtn.disabled = !has;
        const equalAspectBtn = panelEl.querySelector('.equal-aspect-btn');
        if (equalAspectBtn) {
            equalAspectBtn.classList.toggle('active', !!plot?.equalAspect2D);
        }
        const compareBtn = panelEl.querySelector('.compare-files-btn');
        if (compareBtn) {
            compareBtn.disabled = !(has && plot?.mode !== 'state-anim' && this.files.size > 1);
        }
        // Show view-btn-group for 3D modes and state-anim (2D or 3D) with content
        const isAnim = plot?.mode === 'state-anim' && has;
        const is3DMode = this._is3D(plot?.mode) || this._isStateAnim3D(plot);
        const showGroup = is3DMode || isAnim;
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
        } else if (plot.mode === 'state-anim') {
            const slots = plot.stateSlots;
            const d = this.files.get(slots.fileId)?.data;
            if (d) {
                const timeVar  = this._getTimeVar(slots.fileId);
                if (timeVar) {
                    const timeUnit = this._extractUnit(timeVar.description) || 's';
                    headers.push(`time [${timeUnit}]`);
                    columns.push(Array.from(timeVar.data));
                }
                const dim = Math.min(slots.x.length, slots.x.length >= 3 ? 3 : 2);
                // State variables first
                for (let i = 0; i < dim; i++) {
                    const name = slots.x[i];
                    const v = d.variables[name];
                    if (!v) continue;
                    const u = this._extractUnit(v.description);
                    headers.push(u ? `${name} [${u}]` : name);
                    columns.push(Array.from(v.data));
                }
                // Then derivatives
                for (let i = 0; i < dim; i++) {
                    const name = slots.dx[i];
                    if (!name) continue;
                    const v = d.variables[name];
                    if (!v) continue;
                    const u = this._extractUnit(v.description);
                    headers.push(u ? `${name} [${u}]` : name);
                    columns.push(Array.from(v.data));
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

    _compareAcrossFiles(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot || !this._hasContent(plot) || plot.mode === 'state-anim') return;

        // Collect variables used and which files already contribute traces
        const vars = new Set();
        const existingFileIds = new Set();
        if (plot.mode === 'timeseries') {
            for (const t of plot.traces) { vars.add(t.varName); existingFileIds.add(t.fileId); }
        } else {
            for (const pt of plot.phaseTraces) {
                vars.add(pt.x); vars.add(pt.y);
                if (pt.z) vars.add(pt.z);
                existingFileIds.add(pt.fileId);
            }
        }

        const otherFiles = [...this.files.entries()].filter(([fid]) => !existingFileIds.has(fid));
        if (otherFiles.length === 0) {
            Modal.alert(i18n.t('compareFilesErrorTitle'), i18n.t('compareFilesNoOthers'));
            return;
        }

        // Validate every other file has all required variables; abort on first missing
        for (const [, entry] of otherFiles) {
            for (const v of vars) {
                if (!entry.data.variables[v]) {
                    const body = i18n.t('compareFilesErrorBody')
                        .replace('{file}', this._escapeHTML(entry.name))
                        .replace('{var}', this._escapeHTML(v));
                    Modal.alert(i18n.t('compareFilesErrorTitle'), body, { html: true });
                    return;
                }
            }
        }

        // Clone traces with the new fileId for each other file. Dedupe originals first so
        // that running overlay a second time (after loading more files) doesn't multiply
        // copies by the number of files already overlaid.
        if (plot.mode === 'timeseries') {
            const seen = new Set();
            const originals = plot.traces.filter(t => {
                if (seen.has(t.varName)) return false;
                seen.add(t.varName);
                return true;
            });
            for (const [fid] of otherFiles) {
                for (const t of originals) {
                    plot.traces.push({
                        varName: t.varName,
                        color:   this._nextColor(plot.traces.length),
                        fileId:  fid,
                        visible: t.visible ?? true,
                    });
                }
            }
        } else {
            const seen = new Set();
            const originals = plot.phaseTraces.filter(pt => {
                const key = `${pt.x}\u0000${pt.y}\u0000${pt.z || ''}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            for (const [fid] of otherFiles) {
                for (const pt of originals) {
                    plot.phaseTraces.push({
                        x: pt.x, y: pt.y, z: pt.z || null,
                        color:   this._nextColor(plot.phaseTraces.length),
                        fileId:  fid,
                        visible: pt.visible ?? true,
                    });
                }
            }
        }

        this._rebuildPanel(panelId);
    }

    _showPanelStats(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot || !this._hasContent(plot)) return;

        const entries = [];
        const addVar = (fileId, varName) => {
            const d = this.files.get(fileId)?.data;
            const variable = d?.variables[varName];
            if (!variable) return;
            const stats = this._statsForValues(variable.data);
            if (!stats) return;
            entries.push({
                name: this._traceName(varName, fileId),
                unit: this._extractUnit(variable.description),
                ...stats,
            });
        };

        if (plot.mode === 'timeseries') {
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

    // ─── Trace / layout builders ───────────────────────────────────

    _buildPlotData(plot) {
        switch (plot.mode) {
            case 'phase2d':    return { traces: this._buildPhase2DTraces(plot),  layout: this._buildPhase2DLayout(plot)  };
            case 'phase2dt':   return { traces: this._buildPhase2DtTraces(plot), layout: this._buildPhase3DLayout(plot, true)  };
            case 'phase3d':    return { traces: this._buildPhase3DTraces(plot),  layout: this._buildPhase3DLayout(plot, false) };
            case 'state-anim': return { traces: this._buildStateAnimTraces(plot), layout: this._buildStateAnimLayout(plot) };
            default:           return { traces: plot.traces.map(t => this._buildTimeTrace(t)).filter(Boolean), layout: this._buildTimeLayout(plot) };
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
        const name     = this._traceName(t.varName, t.fileId);
        const hoverName = this._escapeHTML(name);
        const hoverTimeUnit = this._escapeHTML(timeUnit);
        const unitStr  = unit ? ` [${this._escapeHTML(unit)}]` : '';

        if (variable.kind === 'parameter') {
            const tStart = timeVar ? timeVar.data[0]                       : 0;
            const tEnd   = timeVar ? timeVar.data[timeVar.data.length - 1] : 1;
            return {
                x: [tStart, tEnd], y: [variable.data[0], variable.data[0]],
                name, type: 'scatter', mode: 'lines',
                visible: t.visible ?? true,
                line: { color: t.color, width: 1.5, dash: 'dash' },
                hovertemplate: `<b>Time [${hoverTimeUnit}]</b> = %{x:.4g}<br><b>${hoverName}</b>${unitStr} = ${this._formatHTMLNumber(variable.data[0])}<extra></extra>`,
            };
        }
        const isStep = variable.dataType === 'boolean';
        const useGL = !isStep && variable.data.length >= PlotManager.GL_POINT_THRESHOLD;
        const line = useGL
            ? { color: t.color, width: 1.5 }
            : { color: t.color, width: 1.5, shape: isStep ? 'hv' : 'linear' };
        return {
            x: timeVar ? timeVar.data : [], y: variable.data,
            name, type: useGL ? 'scattergl' : 'scatter', mode: 'lines',
            visible: t.visible ?? true,
            line,
            hovertemplate: `<b>Time [${hoverTimeUnit}]</b> = %{x:.4g}<br><b>${hoverName}</b>${unitStr} = %{y:.4g}<extra></extra>`,
        };
    }

    _buildTimeLayout(plot) {
        const { bg, gridColor, fontColor, legendBg } = this._colors();
        const firstTrace = plot.traces[0];
        const timeVar  = firstTrace ? this._getTimeVar(firstTrace.fileId) : this._getTimeVar();
        const timeUnit = timeVar ? this._extractUnit(timeVar.description) : 's';
        const multiTrace = plot.traces.length > 1;
        let yTitle = '';
        if (!multiTrace && firstTrace) {
            const d = this.files.get(firstTrace.fileId)?.data;
            const v = d?.variables[firstTrace.varName];
            const unit = v ? this._extractUnit(v.description) : '';
            yTitle = unit ? `${firstTrace.varName} [${unit}]` : firstTrace.varName;
        }

        return {
            paper_bgcolor: bg, plot_bgcolor: bg,
            font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
            showlegend: true,
            xaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                     title: { text: `Time [${timeUnit}]`, font: { size: 10 } } },
            yaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                     title: (yTitle && !multiTrace) ? { text: yTitle, font: { size: 10 } } : { text: '' } },
            legend: this._legendConfig(legendBg, gridColor),
            margin:    this._marginConfig(),
            autosize:  true,
            hovermode: this.hoverProximity ? 'closest' : 'x',
        };
    }

    // ── Phase 2D ──
    _buildPhase2DTraces(plot) {
        const traces = plot.phaseTraces.map(pt => {
            const d = this.files.get(pt.fileId)?.data;
            if (!d) return null;
            const xVar = d.variables[pt.x], yVar = d.variables[pt.y];
            if (!xVar || !yVar) return null;
            const useGL = xVar.data.length >= PlotManager.GL_POINT_THRESHOLD || yVar.data.length >= PlotManager.GL_POINT_THRESHOLD;
            return {
                x: xVar.data, y: yVar.data,
                name: this._traceName(`${pt.x} vs ${pt.y}`, pt.fileId),
                type: useGL ? 'scattergl' : 'scatter', mode: 'lines',
                visible: pt.visible ?? true,
                line: { color: pt.color, width: 1.5 },
            };
        }).filter(Boolean);
        traces.push(this._originCross2D());
        return traces;
    }

    /** Small cross marker at (0,0) used as origin indicator for 2D plots. */
    _originCross2D() {
        const { fontColor } = this._colors();
        // 'cross-thin-open' is a thin + glyph; size controls overall length,
        // marker.line.width controls stroke thickness. Color follows theme.
        return {
            x: [0], y: [0], type: 'scatter', mode: 'markers',
            marker: { symbol: 'cross-thin-open', size: 20, color: fontColor,
                      line: { color: fontColor, width: 1.2 } },
            showlegend: false, hoverinfo: 'skip', name: '__origin__',
        };
    }

    _buildPhase2DLayout(plot) {
        const { bg, gridColor, fontColor, legendBg } = this._colors();
        const first = plot.phaseTraces[0] || {};
        const multiTrace = plot.phaseTraces.length > 1;
        const xu = this._varUnit(first.x, first.fileId);
        const yu = this._varUnit(first.y, first.fileId);
        return {
            paper_bgcolor: bg, plot_bgcolor: bg,
            font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
            showlegend: true,
            legend: this._legendConfig(legendBg, gridColor),
            xaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                     title: { text: multiTrace ? 'x' : (xu ? `${first.x} [${xu}]` : (first.x || 'X')), font: { size: 10 } } },
            yaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                     title: { text: multiTrace ? 'y' : (yu ? `${first.y} [${yu}]` : (first.y || 'Y')), font: { size: 10 } },
                     ...(plot.equalAspect2D ? { scaleanchor: 'x', scaleratio: 1 } : {}) },
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
                x: timeVar ? timeVar.data : [], y: xVar.data, z: yVar.data,
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
        const timeVar  = this._getTimeVar(first.fileId);
        const timeUnit = timeVar ? this._extractUnit(timeVar.description) : 's';

        // phase2dt: plotly X=time,  Y=var x, Z=var y
        // phase3d:  plotly X=var x, Y=var y, Z=var z
        let xLabel, yLabel, zLabel;
        if (isTimez) {
            const yu = this._varUnit(first.x, first.fileId);
            const zu = this._varUnit(first.y, first.fileId);
            xLabel = `Time [${timeUnit}]`;
            yLabel = yu ? `${first.x} [${yu}]` : (first.x || 'x');
            zLabel = zu ? `${first.y} [${zu}]` : (first.y || 'y');
        } else {
            const xu = this._varUnit(first.x, first.fileId);
            const yu = this._varUnit(first.y, first.fileId);
            const zu = this._varUnit(first.z, first.fileId);
            xLabel = xu ? `${first.x} [${xu}]` : (first.x || 'X');
            yLabel = yu ? `${first.y} [${yu}]` : (first.y || 'Y');
            zLabel = zu ? `${first.z} [${zu}]` : (first.z || 'Z');
        }

        const multiTrace = plot.phaseTraces.length > 1;
        // Build explicit axis ranges that include 0 so the origin-anchored decoration
        // lines (red/green/blue) don't trigger autorange expansion when added.
        const xArrays = [], yArrays = [], zArrays = [];
        for (const pt of plot.phaseTraces) {
            if (pt.visible === false) continue;
            const d = this.files.get(pt.fileId)?.data;
            if (!d) continue;
            if (isTimez) {
                const tv = this._getTimeVar(pt.fileId);
                xArrays.push(tv?.data);
                yArrays.push(d.variables[pt.x]?.data);
                zArrays.push(d.variables[pt.y]?.data);
            } else {
                xArrays.push(d.variables[pt.x]?.data);
                yArrays.push(d.variables[pt.y]?.data);
                zArrays.push(d.variables[pt.z]?.data);
            }
        }
        const xRange = this._rangeIncluding0(xArrays);
        const yRange = this._rangeIncluding0(yArrays);
        const zRange = this._rangeIncluding0(zArrays);
        const axisStyle = { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor,
                            backgroundcolor: bg, showbackground: true, zeroline: false,
                            autorange: false };
        // Bold axis-coloured titles match the red/green/blue arrows
        const xTitleFont = { color: '#e74c3c', size: 13, family: 'system-ui, sans-serif', weight: 700 };
        const yTitleFont = { color: '#2ecc71', size: 13, family: 'system-ui, sans-serif', weight: 700 };
        const zTitleFont = { color: '#3498db', size: 13, family: 'system-ui, sans-serif', weight: 700 };
        return {
            paper_bgcolor: bg,
            font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
            showlegend: true,
            legend: this._legendConfig(legendBg, gridColor),
            scene: {
                xaxis: { ...axisStyle, range: xRange,
                         title: { text: (multiTrace && !isTimez) ? 'x' : xLabel, font: xTitleFont },
                         showspikes: true, spikecolor: '#e74c3c', spikethickness: 3, spikesides: false },
                yaxis: { ...axisStyle, range: yRange,
                         title: { text: multiTrace ? (isTimez ? 'x' : 'y') : yLabel, font: yTitleFont },
                         showspikes: true, spikecolor: '#2ecc71', spikethickness: 3, spikesides: false },
                zaxis: { ...axisStyle, range: zRange,
                         title: { text: multiTrace ? (isTimez ? 'y' : 'z') : zLabel, font: zTitleFont },
                         showspikes: true, spikecolor: '#3498db', spikethickness: 3, spikesides: false },
                camera: {
                    // phase2dt default view is rotated around the Z (var y / up) axis so time
                    // (plotly X) reads from the lower-right toward the upper-left of the screen,
                    // with var x (plotly Y) going toward the lower-left and var y (plotly Z) up.
                    eye: isTimez ? { x: 1.25, y: -1.25, z: 1.25 } : { x: 1.25, y: 1.25, z: 1.25 },
                    up:  { x: 0, y: 0, z: 1 },
                    center: { x: 0, y: 0, z: 0 },
                    projection: { type: plot.projection || 'orthographic' },
                },
                bgcolor: bg,
                aspectmode: 'cube',
            },
            margin:   { l: 0, r: 0, t: 10, b: 0 },
            autosize: true,
        };
    }

    // ─── State Animation mode ────────────────────────────────────────

    _addStateAnimVar(panelId, varName, panelEl, plot) {
        const slots = plot.stateSlots;
        if (!slots.fileId) slots.fileId = this.activeFileId;
        const d = this.files.get(slots.fileId)?.data;
        if (!d) return;

        const dim = plot.stateAnimDim || 2;
        if (slots.x.length < dim && !slots.x.includes(varName)) {
            slots.x.push(varName);
        }

        // Auto-detect derivatives
        slots.dx = slots.x.map(name => this.parser.findDerivative(name, d.variables));

        // Need at least 2 state variables to render
        if (slots.x.length >= dim) {
            if (plot.div) {
                this._destroyChart(panelId);
            }
            this._createStateAnimChart(panelId, panelEl);
        } else {
            this._updatePlaceholder(panelId, panelEl);
            if (plot.div) this._setPendingOverlay(panelId, panelEl, true);
        }
    }

    _createStateAnimChart(panelId, panelEl) {
        const plot = this.plots.get(panelId);
        const dim = plot?.stateAnimDim || 2;
        if (!plot || plot.stateSlots.x.length < dim) return;

        const placeholder = panelEl.querySelector('.layout-panel-placeholder');
        if (placeholder) placeholder.style.display = 'none';
        this._setPendingOverlay(panelId, panelEl, false);

        // Remove any old anim container and clean up stale state from a prior
        // mount (split-window re-render reuses the plot state without going
        // through _destroyChart).
        this._stopAnim(plot);
        if (plot.resizeObserver) { plot.resizeObserver.disconnect(); plot.resizeObserver = null; }
        if (plot.div) { try { Plotly.purge(plot.div); } catch (_) {} plot.div = null; }
        delete plot._arrowXIdx;
        delete plot._arrowDxIdx;
        delete plot._xAbsMax;
        delete plot._yAbsMax;
        const oldContainer = panelEl.querySelector('.state-anim-container');
        if (oldContainer) oldContainer.remove();

        // Build container with plot + controls
        const container = document.createElement('div');
        container.className = 'state-anim-container';

        // Slot info bar — two rows: state variables and derivatives
        const slotBar = document.createElement('div');
        slotBar.className = 'state-anim-slots';
        const slots = plot.stateSlots;
        const is3D = dim === 3;
        const labels = ['x₁', 'x₂', 'x₃'];

        let xHtml = '<div class="sa-slot-row"><b>State:</b> ';
        const xCells = slots.x.slice(0, dim).map((n, i) =>
            `${labels[i]} = <span class="sa-slot-var">${this._escapeHTML(n)}</span>`);
        xHtml += xCells.join(' &nbsp;·&nbsp; ');
        xHtml += '</div>';

        let dxHtml = '<div class="sa-slot-row"><b>dx/dt:</b> ';
        const dxCells = slots.dx.slice(0, dim).map((der, i) =>
            der
                ? `d${labels[i]}/dt = <span class="sa-slot-der">${this._escapeHTML(der)}</span>`
                : `d${labels[i]}/dt = <span class="sa-slot-noder">not found</span>`);
        dxHtml += dxCells.join(' &nbsp;·&nbsp; ');
        dxHtml += '</div>';

        slotBar.innerHTML = xHtml + dxHtml;
        container.appendChild(slotBar);

        // Plot div
        const div = document.createElement('div');
        div.className = `plotly-container plotly-mode-state-anim`;
        container.appendChild(div);
        plot.div = div;

        if (is3D && plot.showCameraOverlay) {
            const cameraOverlay = document.createElement('pre');
            cameraOverlay.className = 'camera-debug-overlay';
            cameraOverlay.textContent = 'camera: loading...';
            container.appendChild(cameraOverlay);
            plot.cameraOverlayEl = cameraOverlay;
        } else {
            plot.cameraOverlayEl = null;
        }

        // Controls bar
        const controls = document.createElement('div');
        controls.className = 'state-anim-controls';
        const speedOptions = [
            [0.05, '×0.05'],
            [0.1,  '×0.10'],
            [0.25, '×0.25'],
            [0.5,  '×0.5'],
            [1,    '×1'],
            [2,    '×2'],
            [5,    '×5'],
        ]
            .map(([v, label]) => `<option value="${v}"${Math.abs((plot.animSpeed || 1) - v) < 1e-9 ? ' selected' : ''}>${label}</option>`)
            .join('');
        controls.innerHTML = `
            <button class="sa-btn sa-play-btn" title="${i18n.t('saPlay')}">▶</button>
            <input type="range" class="sa-scrubber" min="0" max="100" value="0" title="${i18n.t('saScrubber')}">
            <span class="sa-time-label">t = 0</span>
            <select class="sa-speed" title="${i18n.t('saSpeed')}">
                ${speedOptions}
            </select>
            <label class="sa-toggle" title="${i18n.t('saFull')}"><input type="checkbox" class="sa-chk-full" checked><span>${i18n.t('saFullLabel')}</span></label>
            <label class="sa-toggle" title="${i18n.t('saTrace')}"><input type="checkbox" class="sa-chk-trace" checked><span>${i18n.t('saTraceLabel')}</span></label>
            <label class="sa-toggle" title="${i18n.t('saArrowX')}"><input type="checkbox" class="sa-chk-arrow" checked><span>x⃗</span></label>
            <label class="sa-toggle" title="${i18n.t('saArrowDx')}"><input type="checkbox" class="sa-chk-dx" checked><span>dx/dt</span></label>
            <label class="sa-toggle" title="${i18n.t('saNorm')}"><input type="checkbox" class="sa-chk-norm" checked><span>${i18n.t('saNormLabel')}</span></label>
            <label class="sa-toggle sa-toggle-dzoom" title="${i18n.t('saDZoom')}"><input type="checkbox" class="sa-chk-dzoom"><span>${i18n.t('saDZoomLabel')}</span></label>
        `;
        container.appendChild(controls);
        // Hide "Zoom on x" for 3D (not supported)
        if (is3D) controls.querySelector('.sa-toggle-dzoom').style.display = 'none';
        panelEl.appendChild(container);

        // Get data
        const d = this.files.get(slots.fileId)?.data;
        const timeVar = this._getTimeVar(slots.fileId);
        if (!d || !timeVar) return;
        const nPts = timeVar.data.length;

        // Set scrubber range
        const scrubber = controls.querySelector('.sa-scrubber');
        scrubber.max = nPts - 1;

        // Build initial Plotly chart
        const { traces, layout } = this._buildPlotData(plot);
        const config = { responsive: true, displayModeBar: false, scrollZoom: true };
        Plotly.newPlot(div, traces, layout, config).then(() => {
            // Add bold axis lines + arrowheads for 3D
            if (is3D) this._add3DAxisDecorations(plot);
            this._stateAnimUpdateFrame(plot, 0);
            this._updateCameraOverlay(plot);
            div.on('plotly_relayout', () => this._updateCameraOverlay(plot));
            div.on('plotly_afterplot', () => this._updateCameraOverlay(plot));
            // Resize observer
            let timer;
            const ro = new ResizeObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(() => Plotly.Plots.resize(div), 50);
            });
            ro.observe(panelEl);
            plot.resizeObserver = ro;

            // Auto-pause on drag: pause animation while user interacts with the plot
            let wasPlaying = false;
            div.addEventListener('mousedown', () => {
                if (plot.animPlaying) {
                    wasPlaying = true;
                    this._stopAnim(plot);
                }
            });
            document.addEventListener('mouseup', () => {
                if (wasPlaying) {
                    wasPlaying = false;
                    this._stateAnimTogglePlay(panelId);
                }
            });

            if (plot.autoPlayOnRender && plot.div === div) {
                plot.autoPlayOnRender = false;
                this._stateAnimTogglePlay(panelId);
            }
        });

        // Bind controls
        const playBtn = controls.querySelector('.sa-play-btn');
        playBtn.addEventListener('click', () => this._stateAnimTogglePlay(panelId));

        scrubber.addEventListener('input', () => {
            this._stopAnim(plot);
            playBtn.textContent = '▶';
            this._stateAnimUpdateFrame(plot, parseInt(scrubber.value));
        });

        controls.querySelector('.sa-speed').addEventListener('change', (e) => {
            plot.animSpeed = parseFloat(e.target.value);
        });

        controls.querySelector('.sa-chk-full').addEventListener('change', (e) => {
            plot.stateConfig.showFullTrace = e.target.checked;
            // Toggle via opacity (not `visible`) so axis ranges don't recompute
            if (plot.div) Plotly.restyle(plot.div, { opacity: e.target.checked ? 1 : 0 }, [0]);
        });
        controls.querySelector('.sa-chk-trace').addEventListener('change', (e) => {
            plot.stateConfig.showTrace = e.target.checked;
            this._stateAnimUpdateFrame(plot, plot.animFrame);
        });
        controls.querySelector('.sa-chk-arrow').addEventListener('change', (e) => {
            plot.stateConfig.showArrowX = e.target.checked;
            this._stateAnimUpdateFrame(plot, plot.animFrame);
        });
        controls.querySelector('.sa-chk-dx').addEventListener('change', (e) => {
            plot.stateConfig.showArrowDx = e.target.checked;
            this._stateAnimUpdateFrame(plot, plot.animFrame);
        });
        controls.querySelector('.sa-chk-norm').addEventListener('change', (e) => {
            plot.stateConfig.normalizeDx = e.target.checked;
            this._stateAnimUpdateFrame(plot, plot.animFrame);
        });
        controls.querySelector('.sa-chk-dzoom').addEventListener('change', (e) => {
            plot.stateConfig.dynamicZoom = e.target.checked;
            if (!e.target.checked && plot.div) {
                this._stateAnimResetView(plot);
            }
            this._stateAnimUpdateFrame(plot, plot.animFrame);
        });

        this._refreshActionBtns(panelId);
    }

    _buildStateAnimTraces(plot) {
        // Static traces: full trajectory (dim) + current partial trace + markers
        const slots = plot.stateSlots;
        const d = this.files.get(slots.fileId)?.data;
        if (!d) return [];
        const is3D = slots.x.length >= 3;

        const xData = d.variables[slots.x[0]]?.data || [];
        const yData = d.variables[slots.x[1]]?.data || [];
        const zData = is3D ? (d.variables[slots.x[2]]?.data || []) : null;

        const traces = [];

        // 0: Full trajectory (faded). Toggled via opacity (not `visible`) so the
        // trace still contributes to autorange → axis ranges stay stable when
        // the user hides it (no annoying dynamic zoom-out).
        const trajColor = is3D ? 'rgba(130,130,130,0.75)' : 'rgba(150,150,150,0.3)';
        const showFull = plot.stateConfig?.showFullTrace !== false;
        const fullTraj = {
            x: xData, y: yData,
            name: 'Full trajectory', mode: 'lines',
            line: { color: trajColor, width: 1 },
            opacity: showFull ? 1 : 0,
            showlegend: false, hoverinfo: 'skip',
        };
        if (is3D) { fullTraj.z = zData; fullTraj.type = 'scatter3d'; }
        traces.push(fullTraj);

        // 1: Partial trace (up to current frame, vivid)
        const partialTraj = {
            x: [], y: [],
            name: 'Trace', mode: 'lines',
            line: { color: '#2196F3', width: 2 },
            showlegend: false, hoverinfo: 'skip',
        };
        if (is3D) { partialTraj.z = []; partialTraj.type = 'scatter3d'; }
        traces.push(partialTraj);

        // 2: Current point marker
        const marker = {
            x: [xData[0]], y: [yData[0]],
            name: 'State', mode: 'markers',
            marker: { size: 8, color: '#ff9800', line: { color: '#fff', width: 1.5 } },
            showlegend: false, hoverinfo: 'skip',
        };
        if (is3D) { marker.z = [zData ? zData[0] : 0]; marker.type = 'scatter3d'; }
        traces.push(marker);

        // Origin cross for 2D state-anim
        if (!is3D) traces.push(this._originCross2D());

        return traces;
    }

    _buildStateAnimLayout(plot) {
        const { bg, gridColor, fontColor } = this._colors();
        const slots = plot.stateSlots;
        const is3D = slots.x.length >= 3;

        const xu = this._varUnit(slots.x[0], slots.fileId);
        const yu = this._varUnit(slots.x[1], slots.fileId);

        if (is3D) {
            const zu = this._varUnit(slots.x[2], slots.fileId);
            const xTitleFont = { color: '#e74c3c', size: 13, family: 'system-ui, sans-serif', weight: 700 };
            const yTitleFont = { color: '#2ecc71', size: 13, family: 'system-ui, sans-serif', weight: 700 };
            const zTitleFont = { color: '#3498db', size: 13, family: 'system-ui, sans-serif', weight: 700 };
            // Explicit ranges including 0 so origin-anchored axis lines don't expand autorange.
            const d = this.files.get(slots.fileId)?.data;
            const xRange = this._rangeIncluding0([d?.variables[slots.x[0]]?.data]);
            const yRange = this._rangeIncluding0([d?.variables[slots.x[1]]?.data]);
            const zRange = this._rangeIncluding0([d?.variables[slots.x[2]]?.data]);
            return {
                paper_bgcolor: bg, plot_bgcolor: bg,
                font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
                showlegend: false,
                scene: {
                    xaxis: { range: xRange, autorange: false,
                             title: { text: xu ? `${slots.x[0]} [${xu}]` : slots.x[0], font: xTitleFont }, gridcolor: gridColor,
                             showspikes: true, spikecolor: '#e74c3c', spikethickness: 3, spikesides: false },
                    yaxis: { range: yRange, autorange: false,
                             title: { text: yu ? `${slots.x[1]} [${yu}]` : slots.x[1], font: yTitleFont }, gridcolor: gridColor,
                             showspikes: true, spikecolor: '#2ecc71', spikethickness: 3, spikesides: false },
                    zaxis: { range: zRange, autorange: false,
                             title: { text: zu ? `${slots.x[2]} [${zu}]` : slots.x[2], font: zTitleFont }, gridcolor: gridColor,
                             showspikes: true, spikecolor: '#3498db', spikethickness: 3, spikesides: false },
                    bgcolor: bg,
                    camera: {
                        ...(plot.homeCamera || { eye: { x: 1.5, y: 1.5, z: 1.2 } }),
                        projection: { type: plot.projection || 'orthographic' },
                    },
                    aspectmode: 'cube',
                },
                margin: { l: 10, r: 10, t: 10, b: 10 },
                autosize: true,
            };
        }

        return {
            paper_bgcolor: bg, plot_bgcolor: bg,
            font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
            showlegend: false,
            xaxis: { title: { text: xu ? `${slots.x[0]} [${xu}]` : slots.x[0], font: { size: 10 } },
                     gridcolor: gridColor, linecolor: gridColor, zeroline: true, zerolinecolor: gridColor },
            yaxis: { title: { text: yu ? `${slots.x[1]} [${yu}]` : slots.x[1], font: { size: 10 } },
                     gridcolor: gridColor, linecolor: gridColor, zeroline: true, zerolinecolor: gridColor,
                     ...(plot.equalAspect2D ? { scaleanchor: 'x', scaleratio: 1 } : {}) },
            margin: this._marginConfig(),
            autosize: true,
            // annotations will be updated per frame
            annotations: [],
        };
    }

    _stateAnimUpdateFrame(plot, frame) {
        if (!plot.div) return;
        const slots = plot.stateSlots;
        const d = this.files.get(slots.fileId)?.data;
        const timeVar = this._getTimeVar(slots.fileId);
        if (!d || !timeVar) return;

        const nPts = timeVar.data.length;
        frame = Math.max(0, Math.min(nPts - 1, frame));
        plot.animFrame = frame;

        const is3D = slots.x.length >= 3;
        const cfg = plot.stateConfig;

        const xAll = d.variables[slots.x[0]]?.data || [];
        const yAll = d.variables[slots.x[1]]?.data || [];
        const zAll = is3D ? (d.variables[slots.x[2]]?.data || []) : null;

        const xNow = xAll[frame] || 0;
        const yNow = yAll[frame] || 0;
        const zNow = is3D ? (zAll ? zAll[frame] : 0) : 0;

        if (is3D) {
            // ── 3D path: direct data mutation (no Plotly API per frame) ──
            this._ensure3DArrowTraces(plot, xNow, yNow, zNow);
            const traces = plot.div.data;

            // Trace 1: partial trajectory
            traces[1].x = cfg.showTrace ? xAll.slice(0, frame + 1) : [];
            traces[1].y = cfg.showTrace ? yAll.slice(0, frame + 1) : [];
            traces[1].z = cfg.showTrace ? zAll.slice(0, frame + 1) : [];

            // Trace 2: current point marker
            traces[2].x = [xNow]; traces[2].y = [yNow]; traces[2].z = [zNow];

            // Arrow x (origin → state) — index stored on plot
            const axIdx = plot._arrowXIdx, dxIdx = plot._arrowDxIdx;
            if (axIdx !== undefined) {
                if (cfg.showArrowX) {
                    traces[axIdx].x = [0, xNow]; traces[axIdx].y = [0, yNow]; traces[axIdx].z = [0, zNow];
                    traces[axIdx].visible = true;
                } else {
                    traces[axIdx].x = []; traces[axIdx].y = []; traces[axIdx].z = [];
                    traces[axIdx].visible = false;
                }
            }

            // Arrow dx/dt
            if (dxIdx !== undefined) {
                const dx0Var = slots.dx[0] ? d.variables[slots.dx[0]] : null;
                const dx1Var = slots.dx[1] ? d.variables[slots.dx[1]] : null;
                const dx2Var = slots.dx[2] ? d.variables[slots.dx[2]] : null;
                if (cfg.showArrowDx && dx0Var && dx1Var && dx2Var) {
                    let dxVal = dx0Var.data[frame] || 0;
                    let dyVal = dx1Var.data[frame] || 0;
                    let dzVal = dx2Var.data[frame] || 0;
                    if (cfg.normalizeDx) {
                        const mag = Math.sqrt(dxVal * dxVal + dyVal * dyVal + dzVal * dzVal);
                        if (mag > 1e-12) {
                            const scale = Math.max(Math.abs(xNow), Math.abs(yNow), Math.abs(zNow), 1) * 0.25;
                            dxVal = (dxVal / mag) * scale;
                            dyVal = (dyVal / mag) * scale;
                            dzVal = (dzVal / mag) * scale;
                        }
                    }
                    traces[dxIdx].x = [xNow, xNow + dxVal]; traces[dxIdx].y = [yNow, yNow + dyVal]; traces[dxIdx].z = [zNow, zNow + dzVal];
                    traces[dxIdx].visible = true;
                } else {
                    traces[dxIdx].x = []; traces[dxIdx].y = []; traces[dxIdx].z = [];
                    traces[dxIdx].visible = false;
                }
            }

            // Throttled redraw during animation (~12fps) to leave room for mouse events.
            // When not animating (scrubber, checkbox toggle), always update immediately.
            const now3D = performance.now();
            const throttle = plot.animPlaying ? 80 : 0;
            if (!plot._lastPlotlyUpdate || now3D - plot._lastPlotlyUpdate >= throttle) {
                plot._lastPlotlyUpdate = now3D;

                Plotly.redraw(plot.div);
            }

        } else {
            // ── 2D path ──
            // Batch restyle for traces 1 (partial) and 2 (marker)
            const partialX = cfg.showTrace ? xAll.slice(0, frame + 1) : [];
            const partialY = cfg.showTrace ? yAll.slice(0, frame + 1) : [];
            Plotly.restyle(plot.div, {
                x: [partialX, [xNow]],
                y: [partialY, [yNow]],
            }, [1, 2]);

            // Annotations for arrows (2D only)
            const annotations = [];
            if (cfg.showArrowX) {
                annotations.push({
                    x: xNow, y: yNow, xref: 'x', yref: 'y',
                    ax: 0, ay: 0, axref: 'x', ayref: 'y',
                    showarrow: true,
                    arrowhead: 3, arrowsize: 1.3, arrowwidth: 2.5,
                    arrowcolor: '#ff9800',
                });
            }
            if (cfg.showArrowDx) {
                const dx0Var = slots.dx[0] ? d.variables[slots.dx[0]] : null;
                const dx1Var = slots.dx[1] ? d.variables[slots.dx[1]] : null;
                if (dx0Var && dx1Var) {
                    let dxVal = dx0Var.data[frame] || 0;
                    let dyVal = dx1Var.data[frame] || 0;
                    if (cfg.normalizeDx) {
                        // Normalize in pixel space so the arrow has a constant on-screen length
                        // regardless of direction or axis aspect asymmetry.
                        const fl = plot.div._fullLayout;
                        const xa = fl?.xaxis, ya = fl?.yaxis;
                        const xRange = xa?.range, yRange = ya?.range;
                        const xLenPx = xa?._length, yLenPx = ya?._length;
                        if (xRange && yRange && xLenPx && yLenPx) {
                            const dpx = Math.abs(xRange[1] - xRange[0]) / xLenPx; // data per pixel (x)
                            const dpy = Math.abs(yRange[1] - yRange[0]) / yLenPx; // data per pixel (y)
                            const magPx = Math.sqrt((dxVal / dpx) ** 2 + (dyVal / dpy) ** 2);
                            if (magPx > 1e-12) {
                                const targetPx = Math.min(xLenPx, yLenPx) * 0.12;
                                dxVal = (dxVal / magPx) * targetPx;
                                dyVal = (dyVal / magPx) * targetPx;
                            }
                        } else {
                            // Fallback before layout is ready: per-axis data-range scaling
                            const mag = Math.sqrt(dxVal * dxVal + dyVal * dyVal);
                            if (mag > 1e-12) {
                                const xScale = xRange ? Math.abs(xRange[1] - xRange[0]) * 0.12 : 1;
                                const yScale = yRange ? Math.abs(yRange[1] - yRange[0]) * 0.12 : xScale;
                                dxVal = (dxVal / mag) * xScale;
                                dyVal = (dyVal / mag) * yScale;
                            }
                        }
                    }
                    annotations.push({
                        x: xNow + dxVal, y: yNow + dyVal, xref: 'x', yref: 'y',
                        ax: xNow, ay: yNow, axref: 'x', ayref: 'y',
                        showarrow: true,
                        arrowhead: 3, arrowsize: 1.3, arrowwidth: 2,
                        arrowcolor: '#9c27b0',
                    });
                }
            }

            // Single relayout for annotations + optional dynamic zoom
            const layoutUpdate = { annotations };
            if (cfg.dynamicZoom) {
                // Per-axis data extents (cached): each axis zooms proportionally to
                // its own scale so Y doesn't get stretched/shrunk when X and Y have
                // very different magnitudes.
                if (plot._xAbsMax === undefined) {
                    let xm = 0, ym = 0;
                    for (let i = 0; i < xAll.length; i++) {
                        const ax = Math.abs(xAll[i]); if (ax > xm) xm = ax;
                        const ay = Math.abs(yAll[i]); if (ay > ym) ym = ay;
                    }
                    plot._xAbsMax = xm || 1;
                    plot._yAbsMax = ym || 1;
                }
                const halfX = Math.max(Math.abs(xNow) * 1.8, plot._xAbsMax * 0.1);
                const halfY = Math.max(Math.abs(yNow) * 1.8, plot._yAbsMax * 0.1);
                layoutUpdate['xaxis.range'] = [xNow - halfX, xNow + halfX];
                layoutUpdate['yaxis.range'] = [yNow - halfY, yNow + halfY];
            }
            Plotly.relayout(plot.div, layoutUpdate);
        }

        // Update scrubber and time label
        const panelEl = plot.div.closest('.layout-panel') || plot.div.closest('.state-anim-container')?.parentElement;
        if (panelEl) {
            const scrubber = panelEl.querySelector('.sa-scrubber');
            if (scrubber) scrubber.value = frame;
            const timeLabel = panelEl.querySelector('.sa-time-label');
            const timeUnit = timeVar ? this._extractUnit(timeVar.description) : 's';
            if (timeLabel) timeLabel.textContent = `t = ${timeVar.data[frame].toPrecision(4)} ${timeUnit}`;
        }
    }

    /** Add bold axis lines with arrowhead cones to any 3D plot. */
    _add3DAxisDecorations(plot) {
        if (!plot.div?._fullLayout?.scene) return;
        const sc = plot.div._fullLayout.scene;
        // Both phase3d and state-anim now set explicit origin-including ranges at
        // layout-build time (with autorange:false), so sc.*.range is reliable and
        // already carries the "+axis must have room" extension.
        const xR = sc.xaxis.range, yR = sc.yaxis.range, zR = sc.zaxis.range;
        // Standard axis colors: X=red, Y=green, Z=blue
        const xCol = '#e74c3c', yCol = '#2ecc71', zCol = '#3498db';
        const isAnim = plot.mode === 'state-anim';
        // ─── Equal-visual-length axis lines (arbitrary box shape) ───
        // Let ar_i be the aspectratio for axis i (visual edge-length ratio).
        // Visual length of a data-segment L_i along axis i ∝ L_i × ar_i / span_i.
        // For equal visual length across axes: L_i = C × span_i / ar_i.
        // Constraint: |L_i| ≤ extent_i (origin→visible-edge distance along chosen direction)
        //             ⇒ C ≤ extent_i × ar_i / span_i.
        const ar = sc.aspectratio || { x: 1, y: 1, z: 1 };
        const arX = ar.x || 1, arY = ar.y || 1, arZ = ar.z || 1;
        const xSpan = Math.max(Math.abs(xR[1] - xR[0]), 1e-12);
        const ySpan = Math.max(Math.abs(yR[1] - yR[0]), 1e-12);
        const zSpan = Math.max(Math.abs(zR[1] - zR[0]), 1e-12);
        // Always draw along +X, +Y, +Z (right-hand convention).
        // Since every range is forced to include 0 at layout time, the positive side
        // always has at least the padding amount of room.
        const xSign = 1, ySign = 1, zSign = 1;
        const xExtent = Math.max(xR[1], 0);
        const yExtent = Math.max(yR[1], 0);
        const zExtent = Math.max(zR[1], 0);
        const cMax = Math.min(
            xExtent * arX / xSpan,
            yExtent * arY / ySpan,
            zExtent * arZ / zSpan,
        );
        // Line-length scale factor:
        //   state-anim (3D): 0.55 × cMax — user feedback OK
        //   non-animated (phase3d, phase2dt): 0.85/3 × cMax — user wants them ~3× shorter
        const C = cMax * (isAnim ? 0.55 : 0.85 / 3);
        const xEnd = xSign * C * xSpan / arX;
        const yEnd = ySign * C * ySpan / arY;
        const zEnd = zSign * C * zSpan / arZ;
        Plotly.addTraces(plot.div, [
            { type: 'scatter3d', mode: 'lines',
              x: [0, xEnd], y: [0, 0], z: [0, 0],
              line: { color: xCol, width: 5 },
              showlegend: false, hoverinfo: 'skip', name: '__axis__' },
            { type: 'scatter3d', mode: 'lines',
              x: [0, 0], y: [0, yEnd], z: [0, 0],
              line: { color: yCol, width: 5 },
              showlegend: false, hoverinfo: 'skip', name: '__axis__' },
            { type: 'scatter3d', mode: 'lines',
              x: [0, 0], y: [0, 0], z: [0, zEnd],
              line: { color: zCol, width: 5 },
              showlegend: false, hoverinfo: 'skip', name: '__axis__' },
        ]);
    }

    /** Lazily add state-vector arrow traces for 3D state-anim (called once). */
    _ensure3DArrowTraces(plot, xNow, yNow, zNow) {
        if (plot._arrowXIdx !== undefined) return; // already added
        const startIdx = plot.div.data.length;
        Plotly.addTraces(plot.div, [
            {
                x: [0, xNow], y: [0, yNow], z: [0, zNow],
                type: 'scatter3d', mode: 'lines+markers',
                line: { color: '#ff9800', width: 5 },
                marker: { size: [0, 4], color: '#ff9800' },
                showlegend: false, hoverinfo: 'skip', name: '__arrow_x__',
            },
            {
                x: [xNow, xNow], y: [yNow, yNow], z: [zNow, zNow],
                type: 'scatter3d', mode: 'lines+markers',
                line: { color: '#9c27b0', width: 5 },
                marker: { size: [0, 4], color: '#9c27b0' },
                showlegend: false, hoverinfo: 'skip', name: '__arrow_dx__',
            },
        ]);
        plot._arrowXIdx  = startIdx;
        plot._arrowDxIdx = startIdx + 1;
    }

    /** Reset the state-anim view to fit all data. */
    _stateAnimResetView(plot) {
        if (!plot.div) return;
        const is3D = plot.stateSlots.x.length >= 3;
        if (is3D) {
            // Find panelId to reuse _setCamera
            const panelId = [...this.plots.entries()].find(([, p]) => p === plot)?.[0];
            if (panelId) this._setCamera(panelId, 'home');
        } else {
            Plotly.relayout(plot.div, {
                'xaxis.autorange': true,
                'yaxis.autorange': true,
            });
        }
    }

    _stateAnimTogglePlay(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        const playBtn = panelEl?.querySelector('.sa-play-btn');

        if (plot.animPlaying) {
            this._stopAnim(plot);
            if (playBtn) playBtn.textContent = '▶';
        } else {
            plot.animPlaying = true;
            if (playBtn) playBtn.textContent = '⏸';

            const timeVar = this._getTimeVar(plot.stateSlots.fileId);
            if (!timeVar) return;
            const nPts = timeVar.data.length;
            const totalDuration = timeVar.data[nPts - 1] - timeVar.data[0];
            // Base wall-clock duration for a full playthrough at ×1 speed (Tend-independent)
            const BASE_WALLCLOCK_SEC = 20;

            let lastT = performance.now();
            const step = () => {
                if (!plot.animPlaying || !plot.div) return;
                const now = performance.now();
                const dt = (now - lastT) / 1000; // seconds elapsed
                lastT = now;

                // Advance so a full playthrough takes BASE_WALLCLOCK_SEC / speed, regardless of Tend
                const simTimeDelta = dt * (totalDuration / BASE_WALLCLOCK_SEC) * plot.animSpeed;
                const currentSimTime = timeVar.data[plot.animFrame];
                const targetSimTime = currentSimTime + simTimeDelta;

                // Find next frame
                let nextFrame = plot.animFrame;
                while (nextFrame < nPts - 1 && timeVar.data[nextFrame] < targetSimTime) nextFrame++;

                if (nextFrame >= nPts - 1) {
                    // Loop back to start
                    nextFrame = 0;
                    lastT = performance.now();
                }

                this._stateAnimUpdateFrame(plot, nextFrame);
                plot.animRAF = requestAnimationFrame(step);
            };
            plot.animRAF = requestAnimationFrame(step);
        }
    }

    _stopAnim(plot) {
        if (!plot) return;
        plot.animPlaying = false;
        if (plot.animRAF) { cancelAnimationFrame(plot.animRAF); plot.animRAF = null; }
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
                const lines = [`<b>t = ${this._formatHTMLNumber(xVal)} ${this._escapeHTML(timeUnit)}</b>`];
                plot.traces.forEach(t => {
                    if (t.visible === 'legendonly' || t.visible === false) return;
                    const d    = this.files.get(t.fileId)?.data;
                    const v    = d?.variables[t.varName];
                    const tvar = this._getTimeVar(t.fileId);
                    const tidx = this._findTimeIdx(tvar?.data, xVal);
                    if (v && v.kind !== 'parameter' && v.data) {
                        const unit  = this._extractUnit(v.description);
                        const label = this._traceName(t.varName, t.fileId);
                        lines.push(`<span style="color:${t.color}">●</span> ${this._escapeHTML(label)} = ${this._formatHTMLNumber(v.data[tidx])}${unit ? ' ' + this._escapeHTML(unit) : ''}`);
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
                const lines = [`<b>t = ${this._formatHTMLNumber(xVal)} ${this._escapeHTML(timeUnit)}</b>`];
                plot.phaseTraces.forEach(pt2 => {
                    if (pt2.visible === 'legendonly' || pt2.visible === false) return;
                    const d = this.files.get(pt2.fileId)?.data;
                    if (!d) return;
                    const xv = d.variables[pt2.x], yv = d.variables[pt2.y];
                    if (xv && yv) {
                        const tvar = this._getTimeVar(pt2.fileId);
                        const tidx = this._findTimeIdx(tvar?.data, xVal);
                        const xu = this._extractUnit(xv.description), yu = this._extractUnit(yv.description);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${this._escapeHTML(pt2.x)} = ${this._formatHTMLNumber(xv.data[tidx])}${xu ? ' ' + this._escapeHTML(xu) : ''}`);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${this._escapeHTML(pt2.y)} = ${this._formatHTMLNumber(yv.data[tidx])}${yu ? ' ' + this._escapeHTML(yu) : ''}`);
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
                        Plotly.restyle(plot.div, { x: [[xVal]], y: [[xv.data[tidx]]], z: [[yv.data[tidx]]], visible: true }, [midx]);
                    });
                }
                const lines = [`<b>t = ${this._formatHTMLNumber(xVal)} ${this._escapeHTML(timeUnit)}</b>`];
                plot.phaseTraces.forEach(pt2 => {
                    if (pt2.visible === 'legendonly' || pt2.visible === false) return;
                    const d = this.files.get(pt2.fileId)?.data;
                    if (!d) return;
                    const xv = d.variables[pt2.x], yv = d.variables[pt2.y];
                    if (xv && yv) {
                        const tvar = this._getTimeVar(pt2.fileId);
                        const tidx = this._findTimeIdx(tvar?.data, xVal);
                        const xu = this._extractUnit(xv.description), zu = this._extractUnit(yv.description);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${this._escapeHTML(pt2.x)} = ${this._formatHTMLNumber(xv.data[tidx])}${xu ? ' ' + this._escapeHTML(xu) : ''}`);
                        lines.push(`<span style="color:${pt2.color}">●</span> ${this._escapeHTML(pt2.y)} = ${this._formatHTMLNumber(yv.data[tidx])}${zu ? ' ' + this._escapeHTML(zu) : ''}`);
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
                const lines = [`<b>t = ${this._formatHTMLNumber(xVal)} ${this._escapeHTML(timeUnit)}</b>`];
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
                            lines.push(`<span style="color:${pt2.color}">●</span> ${this._escapeHTML(name)} = ${this._formatHTMLNumber(v.data[tidx])}${u ? ' ' + this._escapeHTML(u) : ''}`);
                        });
                    }
                });
                this._showInfoBox(panelEl, lines.join('<br>'));

            } else if (plot.mode === 'state-anim') {
                // Sync: jump state-anim to the hovered time
                const tvar = this._getTimeVar(plot.stateSlots.fileId);
                if (tvar) {
                    const tidx = this._findTimeIdx(tvar.data, xVal);
                    this._stateAnimUpdateFrame(plot, tidx);
                }
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

    _updateCameraOverlay(plot) {
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
    }

    _fmtCameraNumber(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '0';
        return n.toFixed(4).replace(/\.?0+$/, '');
    }

    _setCamera(panelId, preset) {
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
    }

    _toggleProjection(panelId, panelEl) {
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
    }

    /**
     * Animate a 90° (or arbitrary angle) rotation of the 3D camera around an axis.
     * axis: 'x', 'y', or 'z'
     * angle: radians to rotate (e.g. Math.PI/2)
     * duration: animation duration in ms
     */
    _animateRotation(panelId, axis, angle, duration) {
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
                this._setMode(panelId, m.id, m.stateAnimDim || null);
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
                    // Home works for both 2D (autorange) and 3D (camera reset)
                    const p = this.plots.get(panelId);
                    if (p?.mode === 'state-anim' && p.stateSlots.x.length < 3) {
                        this._stateAnimResetView(p);
                    } else {
                        this._setCamera(panelId, 'home');
                    }
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
    }

    _updateModeButtons(panelEl, activeMode) {
        const panelId = panelEl.dataset.id;
        const plot = panelId ? this.plots.get(panelId) : null;
        panelEl.querySelectorAll('.mode-btn').forEach(btn => {
            const mode = btn.dataset.mode;
            const dim = btn.dataset.stateAnimDim ? Number(btn.dataset.stateAnimDim) : null;
            btn.classList.toggle('active', mode === activeMode && (!dim || dim === (plot?.stateAnimDim || 2)));
        });
    }

    _toggle3DViewButtons(panelEl, show) {
        const group = panelEl.querySelector('.view-btn-group');
        if (group) group.style.display = show ? '' : 'none';
    }

    _supportsEqualAspect2D(plot) {
        return !!plot && (plot.mode === 'phase2d' || (plot.mode === 'state-anim' && (plot.stateAnimDim || 2) === 2));
    }

    _toggleEqualAspect2D(panelId) {
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
            <small>${i18n.t('multiSelectHint')}</small>
            <small>${i18n.t('legendHint')}</small>
        `;
    }

    // ─── Helpers ───────────────────────────────────────────────────

    _relayoutAll() {
        if (!this.data) return;
        for (const [, plot] of this.plots) {
            if (!plot.div) continue;
            if (this._is3D(plot.mode) || this._isStateAnim3D(plot)) {
                const layout = this._buildPlotData(plot).layout;
                const currentCamera = plot.div._fullLayout?.scene?.camera;
                if (currentCamera && layout.scene) layout.scene.camera = currentCamera;
                Plotly.relayout(plot.div, layout);
                this._refreshAxisDecorations(plot);
            } else {
                Plotly.relayout(plot.div, this._buildPlotData(plot).layout);
                // Origin cross marker color follows theme — restyle it
                this._refreshOriginCross(plot);
            }
        }
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
        if (plot.mode === 'state-anim') return plot.stateSlots.x.length >= (plot.stateAnimDim || 2);
        return plot.phaseTraces.length > 0;
    }

    _is3D(mode) { return mode === 'phase2dt' || mode === 'phase3d'; }
    _isStateAnim3D(plot) { return plot?.mode === 'state-anim' && (plot.stateAnimDim || 2) === 3 && plot.stateSlots?.x?.length >= 3; }

    _rebuildPanel(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!panelEl) return;
        this._destroyChart(panelId);
        plot.markerTraceIdx = null;
        if (this._hasContent(plot)) {
            if (plot.mode === 'state-anim') {
                this._createStateAnimChart(panelId, panelEl);
            } else {
                this._createChart(panelId, panelEl);
            }
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
            equalAspect2D: false,
            resizeObserver: null,
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
        };
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

    _phaseTraceName(plot, pt) {
        const label = plot.mode === 'phase3d'
            ? `${pt.x} / ${pt.y} / ${pt.z}`
            : `${pt.x} vs ${pt.y}`;
        return this._traceName(label, pt.fileId);
    }

    _findTimeIdx(times, xVal) {
        if (!times || !times.length) return 0;
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
    static GL_POINT_THRESHOLD = 50000;

    _nextColor(idx) { return PlotManager.COLORS[idx % PlotManager.COLORS.length]; }
}
