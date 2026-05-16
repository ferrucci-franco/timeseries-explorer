

import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';

export function installPlotStateMethods(TargetClass) {
    const proto = TargetClass.prototype;
    const PlotManager = TargetClass;
proto._addStateAnimVar = function(panelId, varName, panelEl, plot) {
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
};

proto._createStateAnimChart = function(panelId, panelEl) {
    const plot = this.plots.get(panelId);
    const dim = plot?.stateAnimDim || 2;
    if (!plot || plot.stateSlots.x.length < dim) return;
    const restoreView = plot._pendingViewRestore || null;
    delete plot._pendingViewRestore;

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
        <label class="sa-toggle" title="${i18n.t('saArrowX')}"><input type="checkbox" class="sa-chk-arrow" checked><span class="sa-vector-label" aria-label="x vector"><span class="sa-vector-base">x</span><span class="sa-vector-arrow" aria-hidden="true">→</span></span></label>
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
    const nPts = this._getTransformedTimeData(slots.fileId).length;
    if (!nPts) return;

    // Set scrubber range
    const scrubber = controls.querySelector('.sa-scrubber');
    scrubber.max = nPts - 1;

    // Build initial Plotly chart
    const { traces, layout } = this._buildPlotData(plot);
    const config = this._getPlotlyConfig({ displayModeBar: false });
    Plotly.newPlot(div, traces, layout, config).then(() => {
        const restoreAndDecorate = () => {
            if (restoreView) return this._restorePlotView(plot, restoreView);
            return Promise.resolve();
        };
        restoreAndDecorate().then(() => {
            // Add bold axis lines + arrowheads for 3D
            if (is3D) this._add3DAxisDecorations(plot);
            this._stateAnimUpdateFrame(plot, Math.min(plot.animFrame || 0, nPts - 1));
            this._updateCameraOverlay(plot);
        });
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
};

proto._buildStateAnimTraces = function(plot) {
    // Static traces: full trajectory (dim) + current partial trace + markers
    const slots = plot.stateSlots;
    const d = this.files.get(slots.fileId)?.data;
    if (!d) return [];
    const is3D = slots.x.length >= 3;

    const xData = d.variables[slots.x[0]] ? this._getTransformedVariableData(slots.fileId, slots.x[0]) : [];
    const yData = d.variables[slots.x[1]] ? this._getTransformedVariableData(slots.fileId, slots.x[1]) : [];
    const zData = is3D && d.variables[slots.x[2]] ? this._getTransformedVariableData(slots.fileId, slots.x[2]) : null;

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
        marker: { size: is3D ? 5 : 8, color: '#ff9800', line: { color: '#fff', width: 1.5 } },
        showlegend: false, hoverinfo: 'skip',
    };
    if (is3D) { marker.z = [zData ? zData[0] : 0]; marker.type = 'scatter3d'; }
    traces.push(marker);

    // Origin cross for 2D state-anim
    if (!is3D) traces.push(this._originCross2D());

    return traces;
};

proto._buildStateAnimLayout = function(plot) {
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
        const xRange = this._rangeIncluding0([d?.variables[slots.x[0]] ? this._getTransformedVariableData(slots.fileId, slots.x[0]) : []]);
        const yRange = this._rangeIncluding0([d?.variables[slots.x[1]] ? this._getTransformedVariableData(slots.fileId, slots.x[1]) : []]);
        const zRange = this._rangeIncluding0([d?.variables[slots.x[2]] ? this._getTransformedVariableData(slots.fileId, slots.x[2]) : []]);
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
};

proto._stateAnimUpdateFrame = function(plot, frame) {
    if (!plot.div) return;
    const slots = plot.stateSlots;
    const d = this.files.get(slots.fileId)?.data;
    const timeVar = this._getTimeVar(slots.fileId);
    if (!d || !timeVar) return;

    const timeData = this._getTransformedTimeData(slots.fileId);
    const nPts = timeData.length;
    if (!nPts) return;
    frame = Math.max(0, Math.min(nPts - 1, frame));
    plot.animFrame = frame;

    const is3D = slots.x.length >= 3;
    const cfg = plot.stateConfig;

    const xAll = d.variables[slots.x[0]] ? this._getTransformedVariableData(slots.fileId, slots.x[0]) : [];
    const yAll = d.variables[slots.x[1]] ? this._getTransformedVariableData(slots.fileId, slots.x[1]) : [];
    const zAll = is3D && d.variables[slots.x[2]] ? this._getTransformedVariableData(slots.fileId, slots.x[2]) : null;

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
                const dx0Data = this._getTransformedVariableData(slots.fileId, slots.dx[0], { includeYOffset: false });
                const dx1Data = this._getTransformedVariableData(slots.fileId, slots.dx[1], { includeYOffset: false });
                const dx2Data = this._getTransformedVariableData(slots.fileId, slots.dx[2], { includeYOffset: false });
                let dxVal = dx0Data[frame] || 0;
                let dyVal = dx1Data[frame] || 0;
                let dzVal = dx2Data[frame] || 0;
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
                const dx0Data = this._getTransformedVariableData(slots.fileId, slots.dx[0], { includeYOffset: false });
                const dx1Data = this._getTransformedVariableData(slots.fileId, slots.dx[1], { includeYOffset: false });
                let dxVal = dx0Data[frame] || 0;
                let dyVal = dx1Data[frame] || 0;
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
        if (timeLabel) timeLabel.textContent = `t = ${timeData[frame].toPrecision(4)} ${timeUnit}`;
    }
};

/** Add bold axis lines with arrowhead cones to any 3D plot. */
proto._add3DAxisDecorations = function(plot) {
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
};

/** Lazily add state-vector arrow traces for 3D state-anim (called once). */
proto._ensure3DArrowTraces = function(plot, xNow, yNow, zNow) {
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
};

/** Reset the state-anim view to fit all data. */
proto._stateAnimResetView = function(plot) {
    if (!plot.div) return;
    const is3D = plot.stateSlots.x.length >= 3;
    if (is3D) {
        // Find panelId to reuse _setCamera
        const panelId = [...this.plots.entries()].find(([, p]) => p === plot)?.[0];
        if (panelId) this._setCamera(panelId, 'home');
    } else {
        const panelId = [...this.plots.entries()].find(([, p]) => p === plot)?.[0];
        if (panelId) this._autoScalePlot(panelId, plot);
    }
};

proto._stateAnimTogglePlay = function(panelId) {
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
        const timeData = this._getTransformedTimeData(plot.stateSlots.fileId);
        const nPts = timeData.length;
        if (!nPts) return;
        const totalDuration = timeData[nPts - 1] - timeData[0];
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
            const currentSimTime = timeData[plot.animFrame];
            const targetSimTime = currentSimTime + simTimeDelta;

            // Find next frame
            let nextFrame = plot.animFrame;
            while (nextFrame < nPts - 1 && timeData[nextFrame] < targetSimTime) nextFrame++;

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
};

proto._stopAnim = function(plot) {
    if (!plot) return;
    plot.animPlaying = false;
    if (plot.animRAF) { cancelAnimationFrame(plot.animRAF); plot.animRAF = null; }
};

// ─── Axis sync (timeseries only) ───────────────────────────────

}
