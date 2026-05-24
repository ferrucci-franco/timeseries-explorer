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

    plot.traces.forEach((t, idx) => {
        const built = this._buildTimeTrace(t, range);
        if (!built) return;
        const update = { x: [built.x], y: [built.y] };
        if (built.customdata) update.customdata = [built.customdata];
        Plotly.restyle(plot.div, update, [idx]);
    });
    this._refreshElapsedDateTimeAxisTicks(plot, range);
};

proto._refreshTimeseriesVisualsLazy = function(panelId, plot, range) {
    if (!this._zoomTokens) this._zoomTokens = new Map();
    const token = (this._zoomTokens.get(panelId) || 0) + 1;
    this._zoomTokens.set(panelId, token);

    const target = this.timeseriesVisualMaxPoints || 4000;
    const [t0, t1] = range.map(v => Number(v));
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) return Promise.resolve();

    const traceJobs = plot.traces.map((t, idx) => {
        const fileEntry = this.files.get(t.fileId);
        const data = fileEntry?.data;
        const lazyMeta = data?._duckdb;
        if (!lazyMeta) {
            // Mixed lazy/eager: fall back to the sync path for this trace.
            const built = this._buildTimeTrace(t, range);
            if (built) Plotly.restyle(plot.div, { x: [built.x], y: [built.y] }, [idx]);
            return Promise.resolve();
        }

        // Density heuristic: if the in-memory overview already has enough
        // resolution in the visible range, skip the DuckDB round-trip. The
        // overview holds `overviewPoints` samples spread uniformly across
        // [timeStart, timeEnd]; for a viewport covering `coverage` of that
        // span, it carries ~ overviewPoints*coverage samples — already
        // greater than the target visual budget when zoomed out far.
        const tStart = Number(data?.metadata?.timeStart);
        const tEnd = Number(data?.metadata?.timeEnd);
        if (Number.isFinite(tStart) && Number.isFinite(tEnd) && tEnd > tStart) {
            const coverage = (Math.min(t1, tEnd) - Math.max(t0, tStart)) / (tEnd - tStart);
            const overviewPts = lazyMeta.overviewPoints || 10000;
            if (coverage >= (target / overviewPts)) {
                // Overview is enough — use the sync path (slice + downsample in JS).
                const built = this._buildTimeTrace(t, range);
                if (built) Plotly.restyle(plot.div, { x: [built.x], y: [built.y] }, [idx]);
                return Promise.resolve();
            }
        }

        const source = lazyMeta.source;
        if (!source?.getColumnRange) return Promise.resolve();
        return source.getColumnRange(data, t.varName, t0, t1, target)
            .then(({ x, y }) => {
                // Drop the result if a newer zoom superseded this one.
                if (this._zoomTokens.get(panelId) !== token) return;
                if (!plot?.div || !plot.traces[idx]) return;
                Plotly.restyle(plot.div, { x: [x], y: [y] }, [idx]);
            })
            .catch(err => {
                if (this._zoomTokens.get(panelId) !== token) return;
                console.warn('[duckdb] viewport query failed; using overview slice:', err?.message || err);
                const built = this._buildTimeTrace(t, range);
                if (built) Plotly.restyle(plot.div, { x: [built.x], y: [built.y] }, [idx]);
            });
    });
    this._refreshElapsedDateTimeAxisTicks(plot, range);
    const settled = Promise.all(traceJobs);
    // Expose the in-flight promise so benchmarks (or tests) can await it.
    this._lastLazyRefresh = settled;
    return settled;
};

proto._refreshElapsedDateTimeAxisTicks = function(plot, range = null) {
    if (!plot?.div || plot.mode !== 'timeseries') return;
    const fid = this._primaryTimeFileId(plot);
    const timeVar = this._getTimeVar(fid);
    if (this._timeDisplayModeForVar(fid, timeVar) !== 'elapsedDateTime' && !this._isGeneratedDurationTime(fid, timeVar)) return;
    const values = Array.isArray(range) && range.length >= 2
        ? range.map(value => {
            const numeric = Number(value);
            return Number.isFinite(numeric) ? numeric : NaN;
        })
        : plot.traces.map(t => this._getTransformedTimeData(t.fileId));
    const config = this._elapsedDateTimeAxisConfig(values);
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
                        const tidx = this._findTimeIdx(tdata, xVal);
                        const midx = Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx[i] : plot.markerTraceIdx;
                        if (hidden) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
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
                        const tidx = this._findTimeIdx(tdata, xVal);
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
                        const tidx = this._findTimeIdx(tdata, xVal);
                        const midx = Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx[i] : plot.markerTraceIdx;
                        if (hidden) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
                        const xdata = this._getTransformedVariableData(pt2.fileId, pt2.x);
                        const ydata = this._getTransformedVariableData(pt2.fileId, pt2.y);
                        Plotly.restyle(plot.div, { x: [[this._plotlyTimeValue(pt2.fileId, xVal, this._getTimeVar(pt2.fileId))]], y: [[xdata[tidx]]], z: [[ydata[tidx]]], visible: true }, [midx]);
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
                        const tidx = this._findTimeIdx(tdata, xVal);
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
                        const tidx = this._findTimeIdx(tdata, xVal);
                        const midx = Array.isArray(plot.markerTraceIdx) ? plot.markerTraceIdx[i] : plot.markerTraceIdx;
                        if (hidden) { Plotly.restyle(plot.div, { visible: false }, [midx]); return; }
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
                        const tidx = this._findTimeIdx(tdata, xVal);
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
    return { enabled: false, a: null, b: null, traceA: null, traceB: null };
};

proto._toggleCursors = function(panelId) {
    const plot = this.plots.get(panelId);
    if (!plot || plot.mode !== 'timeseries' || !plot.div) return;
    if (!plot.cursors) plot.cursors = this._defaultCursors();
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
            return { times: rx, values: ry };
        }
    }
    const times = this._getTransformedTimeData(trace.fileId);
    const values = this._getTransformedVariableData(trace.fileId, trace.varName);
    if (!times?.length || !values?.length) return null;
    return { times, values };
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

proto._jumpCursorTo = function(panelId, which, target, direction = 'next') {
    const plot = this.plots.get(panelId);
    if (!plot?.cursors?.enabled) return;
    const trace = this._resolveCursorTrace(plot, which);
    if (!trace) return;
    const cursorX = plot.cursors[which];
    if (!Number.isFinite(cursorX)) return;
    const times  = this._getTransformedTimeData(trace.fileId);
    const values = this._getTransformedVariableData(trace.fileId, trace.varName);
    let nextX = NaN;
    if (target === 'max' || target === 'min') {
        nextX = this._findNextExtremum(times, values, cursorX, target, direction);
    } else if (target === 'sample') {
        nextX = this._findNextSampleValue(times, cursorX, direction);
    } else if (target === 'zero') {
        nextX = this._findNextZeroCrossing(times, values, cursorX, this._traceInterpolationMode(trace), direction);
    }
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

proto._cursorOverlayGeometry = function(plot, trace, x) {
    if (!plot?.div || !trace || !Number.isFinite(x)) return null;
    const fl = plot.div._fullLayout;
    const xa = fl?.xaxis;
    const ya = fl?.yaxis;
    if (!xa?.range || !ya?.range || !xa._length || !ya._length) return null;

    const x0 = this._coerceAxisValue(xa.range[0]);
    const x1 = this._coerceAxisValue(xa.range[1]);
    const rx = x1 - x0;
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || rx === 0) return null;

    const series = this._traceInterpolationSeries(plot, trace);
    const y = series
        ? this._interpolateAt(series.times, series.values, x, this._traceInterpolationMode(trace))
        : NaN;
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

proto._renderCursorOverlay = function(plot) {
    if (!plot?.div || !plot.cursors?.enabled) return;
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
    for (const item of items) {
        const g = this._cursorOverlayGeometry(plot, item.trace, item.x);
        if (!g) continue;
        if (g.left < g.leftAxis || g.left > g.rightAxis) continue;
        const lineStyle = [
            `left:${g.left}px`,
            `top:${g.topAxis}px`,
            `height:${Math.max(0, g.bottomAxis - g.topAxis)}px`,
            `border-left-color:${item.color}`,
            item.dash ? 'border-left-style:dashed' : '',
        ].filter(Boolean).join(';');
        parts.push(`<div class="cursor-overlay-line cursor-overlay-line-${item.key}" style="${lineStyle}"></div>`);
        if (Number.isFinite(g.top) && g.top >= g.topAxis && g.top <= g.bottomAxis) {
            parts.push(`<div class="cursor-overlay-dot cursor-overlay-dot-${item.key}" style="left:${g.left}px;top:${g.top}px;background:${item.color};border-color:${item.color}"></div>`);
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
        if (!hit) return;
        dragging = hit;
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
        plot.cursors[dragging] = this._clampCursorX(plot, dragging, x);
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
    const labelX = this._escapeHTML(i18n.t('cursorLabelX'));
    const labelY = this._escapeHTML(i18n.t('cursorLabelY'));
    const labelDx = this._escapeHTML(i18n.t('cursorLabelDeltaX'));
    const labelDy = this._escapeHTML(i18n.t('cursorLabelDeltaY'));
    const labelSlope = this._escapeHTML(i18n.t('cursorLabelSlope'));
    const labelInvDx = this._escapeHTML(i18n.t('cursorLabelInverseDeltaX'));
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
        <div class="cursor-info-hint">${shiftHint}</div>
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
