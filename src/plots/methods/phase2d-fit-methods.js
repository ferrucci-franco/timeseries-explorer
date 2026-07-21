import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';
import {
    defaultPhase2dState,
    normalizePhase2dState,
    phase2dPlotlyMode,
    phase2dShowsMarkers,
    clampNumber,
    MARKER_SIZE_MIN,
    MARKER_SIZE_MAX,
    MARKER_OPACITY_MIN,
    MARKER_OPACITY_MAX,
    PHASE2D_DISPLAY_MODES,
    PHASE2D_FIT_MODELS,
} from '../phase2d-state.js';
import { fitPair, buildFitCurve } from '../../utils/regression.js';

// Range-input formatting / datetime conversion — mirrors the FFT & Correlation
// panels so the Todo/Selección controls look and behave identically.
const PHASE2D_FIT_LAYOUTS = new Set(['horizontal', 'vertical']);
const p2dFiniteOrNull = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};
const p2dFormatInputValue = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    if (n !== 0 && Math.abs(n) < 0.01) return n.toExponential(2);
    return String(Number(n.toFixed(2)));
};
const p2dMsToDatetimeInput = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n)) return '';
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 19);
};
const p2dDatetimeInputToMs = (text) => {
    if (!text) return NaN;
    const ms = Date.parse(`${text}Z`);
    return Number.isFinite(ms) ? ms : NaN;
};

// TODO 10 — 2D mode: point/line display + (later) linear/quadratic fitting.
// Phase 1 installs only the display state and the Lines / Points / Lines+points
// controls with compact marker options; the fitting shell/kernel come in later
// phases into this same module. Pure state lives in plots/phase2d-state.js.

export function installPlotPhase2dFitMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // ── State ──────────────────────────────────────────────────────
    proto._defaultPhase2dState = function() {
        return defaultPhase2dState();
    };

    proto._normalizePhase2dState = function(raw = {}) {
        return normalizePhase2dState(raw);
    };

    proto._ensurePhase2dState = function(plot) {
        if (!plot) return defaultPhase2dState();
        if (!plot.phase2d) {
            plot.phase2d = normalizePhase2dState({});
            return plot.phase2d;
        }
        Object.assign(plot.phase2d, normalizePhase2dState(plot.phase2d));
        return plot.phase2d;
    };

    proto._phase2dPlotlyMode = function(state) {
        return phase2dPlotlyMode(state);
    };

    proto._phase2dShowsMarkers = function(state) {
        return phase2dShowsMarkers(state);
    };

    // ── Display + marker toolbar controls (phase2d only) ────────────
    proto._injectPhase2dDisplayControls = function(panelId, toolbar, plot) {
        if (!toolbar || plot?.mode !== 'phase2d') return;
        const state = this._ensurePhase2dState(plot);

        const group = document.createElement('div');
        group.className = 'phase2d-tools-group';

        // Display: Lines / Points / Lines+points as a compact select.
        const displaySelect = document.createElement('select');
        displaySelect.className = 'phase2d-display-select';
        displaySelect.title = i18n.t('phase2dDisplayTooltip');
        displaySelect.setAttribute('aria-label', i18n.t('phase2dDisplayLabel'));
        [
            ['lines', i18n.t('phase2dDisplayLines')],
            ['markers', i18n.t('phase2dDisplayPoints')],
            ['lines+markers', i18n.t('phase2dDisplayLinesPoints')],
        ].forEach(([value, label]) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            if (value === state.displayMode) opt.selected = true;
            displaySelect.appendChild(opt);
        });
        displaySelect.addEventListener('change', () => this._setPhase2dDisplayMode(panelId, displaySelect.value));
        group.appendChild(displaySelect);

        // Compact marker size / opacity — only when points are shown.
        const markerWrap = document.createElement('div');
        markerWrap.className = 'phase2d-marker-controls';
        markerWrap.hidden = !this._phase2dShowsMarkers(state);

        const makeNumber = (key, labelKey, min, max, step, value) => {
            const label = document.createElement('label');
            label.className = 'phase2d-marker-field';
            label.title = i18n.t(labelKey);
            const span = document.createElement('span');
            span.textContent = i18n.t(labelKey);
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'phase2d-marker-input';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(value);
            input.setAttribute('aria-label', i18n.t(labelKey));
            input.addEventListener('change', () => this._setPhase2dMarkerSetting(panelId, key, input.value));
            label.append(span, input);
            return label;
        };
        markerWrap.append(
            makeNumber('markerSize', 'phase2dMarkerSize', MARKER_SIZE_MIN, MARKER_SIZE_MAX, 1, state.markerSize),
            makeNumber('markerOpacity', 'phase2dMarkerOpacity', MARKER_OPACITY_MIN, MARKER_OPACITY_MAX, 0.05, state.markerOpacity),
        );
        group.appendChild(markerWrap);

        // Fitting: Off / Linear / Quadratic (TODO 10 Phase 2). Off keeps the plain
        // 2D plot; Linear/Quadratic overlay an OLS fit curve per pair and reveal
        // the collapsible options/results drawer.
        const fitSelect = document.createElement('select');
        fitSelect.className = 'phase2d-fit-select';
        fitSelect.title = i18n.t('phase2dFitTooltip');
        fitSelect.setAttribute('aria-label', i18n.t('phase2dFitLabel'));
        [
            ['none', i18n.t('phase2dFitOff')],
            ['linear', i18n.t('phase2dFitLinear')],
            ['quadratic', i18n.t('phase2dFitQuadratic')],
        ].forEach(([value, label]) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            if (value === state.fitModel) opt.selected = true;
            fitSelect.appendChild(opt);
        });
        fitSelect.addEventListener('change', () => this._setPhase2dFitModel(panelId, fitSelect.value));
        group.appendChild(fitSelect);
        // A fit reveals the FFT-like workspace; its Options toggle lives in the
        // shell topbar (no separate toolbar button needed).

        toolbar.appendChild(group);
    };

    proto._setPhase2dDisplayMode = function(panelId, displayMode) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'phase2d') return;
        const state = this._ensurePhase2dState(plot);
        state.displayMode = PHASE2D_DISPLAY_MODES.has(displayMode) ? displayMode : 'lines';
        // Show/hide the compact marker controls without a full toolbar rebuild.
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        const markerWrap = panelEl?.querySelector('.phase2d-marker-controls');
        if (markerWrap) markerWrap.hidden = !this._phase2dShowsMarkers(state);
        this._restylePhase2dDisplay(panelId, plot);
    };

    proto._setPhase2dMarkerSetting = function(panelId, key, rawValue) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'phase2d') return;
        const state = this._ensurePhase2dState(plot);
        if (key === 'markerSize') state.markerSize = clampNumber(rawValue, MARKER_SIZE_MIN, MARKER_SIZE_MAX, state.markerSize);
        else if (key === 'markerOpacity') state.markerOpacity = clampNumber(rawValue, MARKER_OPACITY_MIN, MARKER_OPACITY_MAX, state.markerOpacity);
        else return;
        this._restylePhase2dDisplay(panelId, plot);
    };

    // Display change is a pure restyle over the SAME visual data — no query, no
    // pair change, no fitting recompute (that matters for the lazy path).
    proto._restylePhase2dDisplay = function(panelId, plot = this.plots.get(panelId)) {
        if (!plot?.div || plot.mode !== 'phase2d') return;
        const state = this._ensurePhase2dState(plot);
        const mode = this._phase2dPlotlyMode(state);
        const showMarkers = this._phase2dShowsMarkers(state);
        const data = plot.div.data || [];
        const indices = [];
        const modes = [];
        const markers = [];
        const types = [];
        let typeChanged = false;
        data.forEach((tr, i) => {
            // Leave the origin cross, transient hover markers, and fit curves
            // alone — fit lines must stay dashed lines regardless of Display.
            if (!tr || tr.name === '__origin__' || tr.name === '__hover__' || tr._phase2dFit) return;
            indices.push(i);
            modes.push(mode);
            const color = tr.line?.color || tr.marker?.color;
            markers.push(showMarkers
                ? { color, size: state.markerSize, opacity: state.markerOpacity }
                : { color });
            // Toggling markers on/off can cross the WebGL point threshold, so a
            // Points display doesn't crawl in SVG. Only send `type` when it
            // actually changes — restyling `type` forces a replot, and marker
            // size/opacity tweaks must stay cheap.
            const len = Math.max(tr.x?.length || 0, tr.y?.length || 0);
            const wantType = this._phase2dUseGL(len, showMarkers) ? 'scattergl' : 'scatter';
            types.push(wantType);
            if (wantType !== (tr.type || 'scatter')) typeChanged = true;
        });
        if (!indices.length) return;
        const update = { mode: modes, marker: markers };
        if (typeChanged) update.type = types;
        Plotly.restyle(plot.div, update, indices);
    };

    // ── Eager fitting pipeline (TODO 10 Phase 2) ────────────────────
    // Full-resolution, pairwise-finite rows for one pair. This is the EXACT
    // data the fit uses — never the visual/downsampled trajectory. gain/yOffset
    // are already applied by the transformed-data getters. In Selección only the
    // rows whose transformed time falls inside [lo, hi] participate; value-level
    // NaN/±Inf are left for the kernel to exclude and count.
    proto._phase2dPairSeries = function(plot, pair) {
        const state = this._ensurePhase2dState(plot);
        const xVals = this._getTransformedVariableData(pair.fileId, pair.x);
        const yVals = this._getTransformedVariableData(pair.fileId, pair.y);
        if (state.rangeFull) {
            const n = Math.min(xVals?.length || 0, yVals?.length || 0);
            return { x: (xVals || []).slice(0, n), y: (yVals || []).slice(0, n), nScope: n };
        }
        const times = this._getTransformedTimeDataForVariable(pair.fileId, pair.x);
        const n = Math.min(times?.length || 0, xVals?.length || 0, yVals?.length || 0);
        const [lo, hi] = this._phase2dFitActiveRange(plot);
        const x = [];
        const y = [];
        for (let i = 0; i < n; i++) {
            const t = Number(times[i]);
            if (t >= lo && t <= hi) { x.push(xVals[i]); y.push(yVals[i]); }
        }
        return { x, y, nScope: x.length };
    };

    // Compute one OLS fit per visible pair for the active model, cache on the
    // plot, and return the results. Lazy (DuckDB) files are not fitted eagerly
    // yet — they are flagged so the drawer can say so without a wrong number.
    proto._computePhase2dFits = function(plot) {
        const state = this._ensurePhase2dState(plot);
        if (state.fitModel === 'none') { plot._phase2dFits = []; return plot._phase2dFits; }
        const results = [];
        (plot.phaseTraces || []).forEach((pair, index) => {
            if (pair.visible === false) return;
            const label = this._phase2dFitPairLabel(plot, pair);
            if (this._isLazyFile?.(pair.fileId)) {
                results.push({ pair, index, label, fit: null, curve: null, nScope: NaN, lazy: true });
                return;
            }
            const series = this._phase2dPairSeries(plot, pair);
            const fit = fitPair(state.fitModel, series.x, series.y);
            const curve = fit && fit.status === 'ok' ? buildFitCurve(fit) : { x: [], y: [] };
            results.push({ pair, index, label, fit, curve, nScope: series.nScope, lazy: false });
        });
        plot._phase2dFits = results;
        return results;
    };

    // Plotly traces for the fit curves: same colour as the pair, thicker dashed
    // line, no legend duplication of markers. Appended after data traces and
    // before the origin cross by _buildPhase2DTraces.
    proto._buildPhase2dFitCurveTraces = function(plot) {
        const state = this._ensurePhase2dState(plot);
        if (state.fitModel === 'none') return [];
        const results = this._computePhase2dFits(plot);
        const modelWord = state.fitModel === 'quadratic'
            ? i18n.t('phase2dFitQuadratic') : i18n.t('phase2dFitLinear');
        const traces = [];
        for (const r of results) {
            if (!r.curve || !r.curve.x.length) continue;
            traces.push({
                x: r.curve.x,
                y: r.curve.y,
                type: 'scatter',
                mode: 'lines',
                name: `${modelWord} · ${r.label}`,
                line: { color: r.pair.color, width: 2.5, dash: 'dash' },
                hovertemplate: `<b>${this._escapeHTML(modelWord)}</b><br>`
                    + `x = %{x:.4g}<br>ŷ = %{y:.4g}`
                    + `<extra>${this._escapeHTML(r.label)}</extra>`,
                _phase2dFit: true,
            });
        }
        return traces;
    };

    proto._phase2dFitPairLabel = function(plot, pair) {
        const xName = this._traceName ? this._traceName(pair.x, pair.fileId) : pair.x;
        const yName = this._traceName ? this._traceName(pair.y, pair.fileId) : pair.y;
        return `${xName} vs ${yName}`;
    };

    // Range-limited VISUAL points for the scatter when a Selección is active, so
    // the 2D pane shows the same window the fit uses. Eager only (lazy keeps the
    // normal visual path). Downsampled with the shared visual cap; each drawn
    // point is a real X/Y row pair (never mixed across rows). Returns null when
    // rangeFull / lazy so callers fall back to _phaseVisualDataForTrace.
    proto._phase2dRangeLimitedVisual = function(plot, pt) {
        const state = this._ensurePhase2dState(plot);
        if (state.fitModel === 'none' || state.rangeFull) return null;
        if (this._isLazyFile?.(pt.fileId)) return null;
        const times = this._getTransformedTimeDataForVariable(pt.fileId, pt.x);
        const xAll = this._getTransformedVariableData(pt.fileId, pt.x);
        const yAll = this._getTransformedVariableData(pt.fileId, pt.y);
        const n = Math.min(times?.length || 0, xAll?.length || 0, yAll?.length || 0);
        if (!n) return null;
        const [lo, hi] = this._phase2dFitActiveRange(plot);
        const xs = [];
        const ys = [];
        for (let i = 0; i < n; i++) {
            const t = Number(times[i]);
            if (t >= lo && t <= hi) { xs.push(xAll[i]); ys.push(yAll[i]); }
        }
        const [x, y] = this._buildPhaseVisualSeries([xs, ys]);
        return { x, y };
    };

    // ── Fit model change: enter / update / exit the FFT-like shell ──
    proto._setPhase2dFitModel = function(panelId, model) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'phase2d') return;
        const state = this._ensurePhase2dState(plot);
        const prev = state.fitModel;
        state.fitModel = PHASE2D_FIT_MODELS.has(model) ? model : 'none';
        const active = state.fitModel !== 'none';
        const wasActive = prev !== 'none';

        if (active && !wasActive) {
            this._enterPhase2dFitShell(panelId, plot);
        } else if (!active && wasActive) {
            this._exitPhase2dFitShell(panelId, plot);
            this._rerenderPhase2dPlot(panelId, plot);
        } else if (active) {
            // Only the model changed (linear <-> quadratic): recompute in place.
            this._rerenderPhase2dPlot(panelId, plot);
            this._renderPhase2dFitDrawer(panelId, plot);
        }
    };

    // Re-render the 2D plot preserving the current view (a fit/range change must
    // not rescale it). plot.div stays the same 2D div so 1:1 / autoscale /
    // legend keep working whether standalone or inside the shell.
    proto._rerenderPhase2dPlot = function(panelId, plot = this.plots.get(panelId)) {
        if (!plot?.div || plot.mode !== 'phase2d') return Promise.resolve();
        const { traces, layout } = this._buildPlotData(plot);
        const xr = plot.div._fullLayout?.xaxis?.range;
        const yr = plot.div._fullLayout?.yaxis?.range;
        if (Array.isArray(xr)) layout.xaxis = { ...(layout.xaxis || {}), range: xr.slice(), autorange: false };
        if (Array.isArray(yr)) layout.yaxis = { ...(layout.yaxis || {}), range: yr.slice(), autorange: false };
        return Plotly.react(plot.div, traces, layout, this._getPlotlyConfig());
    };

    // ── Shell (topbar + temporal pane + splitter + 2D pane + drawer) ─
    // Keeps plot.div as the SAME 2D div (reparented into the shell) so all the
    // existing 2D pan/zoom/1:1/legend handlers survive. Mirrors the FFT /
    // Correlation shell contract with phase2d-owned state and listeners.
    proto._enterPhase2dFitShell = function(panelId, plot) {
        const div = plot.div;
        const panelEl = div?.closest('.layout-panel')
            || document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!div || !panelEl || plot.phase2dFitContainer) return;
        const state = this._ensurePhase2dState(plot);

        const container = document.createElement('div');
        container.className = `fft-container phase2d-fit-container fft-layout-${state.layout}`;
        container.style.setProperty('--fft-split', `${Math.round(state.split * 1000) / 10}%`);

        const makeButton = (className, text, title, onClick) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = className;
            b.textContent = text;
            b.title = title;
            b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
            return b;
        };

        // Topbar: V/H, Reset, Options, status.
        const topbar = document.createElement('div');
        topbar.className = 'fft-topbar';
        const layoutGroup = document.createElement('div');
        layoutGroup.className = 'fft-topbar-group';
        const layoutBtn = makeButton('fft-tool-btn', 'V/H', i18n.t('fftLayoutToggle'), () => {
            const cur = this._ensurePhase2dState(plot).layout;
            this._setPhase2dFitLayout(panelId, cur === 'horizontal' ? 'vertical' : 'horizontal');
        });
        layoutBtn.setAttribute('aria-label', i18n.t('fftLayoutToggle'));
        layoutGroup.appendChild(layoutBtn);
        const actionGroup = document.createElement('div');
        actionGroup.className = 'fft-topbar-group';
        const optionsBtn = makeButton('fft-tool-btn fft-options-btn', i18n.t('fftOptionsLabel'), i18n.t('fftOptionsToggle'), () => this._togglePhase2dOptions(panelId));
        optionsBtn.classList.toggle('active', state.optionsVisible);
        optionsBtn.setAttribute('aria-pressed', String(state.optionsVisible));
        actionGroup.append(
            makeButton('fft-tool-btn', i18n.t('fftResetLabel'), i18n.t('fftResetView'), () => this._resetPhase2dFitView(panelId)),
            optionsBtn,
        );
        const status = document.createElement('span');
        status.className = 'fft-status';
        status.setAttribute('aria-live', 'polite');
        topbar.append(layoutGroup, actionGroup, status);

        const workspace = document.createElement('div');
        workspace.className = 'fft-workspace';
        const plotArea = document.createElement('div');
        plotArea.className = 'fft-plot-area';
        const timePane = document.createElement('div');
        timePane.className = 'fft-pane fft-time-pane';
        const scatterPane = document.createElement('div');
        scatterPane.className = 'fft-pane fft-spectrum-pane';
        const splitter = document.createElement('div');
        splitter.className = 'fft-splitter';
        splitter.setAttribute('role', 'separator');

        const timeDiv = document.createElement('div');
        timeDiv.className = 'plotly-container plotly-mode-phase2d-fit-time';
        timePane.appendChild(timeDiv);
        // Move the EXISTING 2D plot into the scatter pane (keeps its handlers).
        scatterPane.appendChild(div);
        plotArea.append(timePane, splitter, scatterPane);

        const options = document.createElement('aside');
        options.className = 'fft-options phase2d-fit-options';
        options.hidden = !state.optionsVisible;
        options.setAttribute('aria-label', i18n.t('phase2dFitResultsTitle'));
        workspace.append(plotArea, options);
        container.append(topbar, workspace);
        panelEl.appendChild(container);

        plot.phase2dFitContainer = container;
        plot.phase2dFitTimeDiv = timeDiv;
        plot.phase2dFitOptions = options;

        this._ensurePhase2dFitRange(plot);
        Plotly.newPlot(timeDiv, this._buildPhase2dFitTimeTraces(plot), this._buildPhase2dFitTimeLayout(plot), this._getPlotlyConfig()).then(() => {
            timeDiv.on('plotly_doubleclick', () => { this._autoScalePhase2dFitTime(plot); return false; });
            timeDiv.on('plotly_relayout', (ed) => {
                const touchesX = ed && (
                    ed['xaxis.autorange'] !== undefined
                    || ed['xaxis.range'] !== undefined
                    || ed['xaxis.range[0]'] !== undefined
                    || ed['xaxis.range[1]'] !== undefined
                );
                if (!touchesX) return;
                clearTimeout(plot._phase2dFitVisualTimer);
                plot._phase2dFitVisualTimer = setTimeout(() => {
                    const r = timeDiv?._fullLayout?.xaxis?.range;
                    this._refreshPhase2dFitTimeVisuals(panelId, plot, Array.isArray(r) ? r : null);
                }, 120);
            });
            this._installPhase2dFitSelectionHandlers(panelId, plot);
            this._installPhase2dFitSplitterHandlers(panelId, plot);
            this._installWheelPan?.(panelId, plot, timeDiv, {});
            this._installRightButtonPan?.(panelId, plot, timeDiv, {});
            Plotly.Plots.resize(div);
        });

        this._renderPhase2dFitDrawer(panelId, plot);
        // Add the fit curves to the (reparented) 2D plot.
        this._rerenderPhase2dPlot(panelId, plot);
    };

    proto._exitPhase2dFitShell = function(panelId, plot = this.plots.get(panelId)) {
        const container = plot?.phase2dFitContainer;
        const div = plot?.div;
        if (!container) return;
        const panelEl = container.closest('.layout-panel');
        // Move the 2D plot back out as a direct child of the panel.
        if (div && panelEl) panelEl.appendChild(div);
        if (plot.phase2dFitTimeDiv) { Plotly.purge(plot.phase2dFitTimeDiv); }
        this._cleanupPhase2dFitDocListeners(plot);
        container.remove();
        plot.phase2dFitContainer = null;
        plot.phase2dFitTimeDiv = null;
        plot.phase2dFitOptions = null;
        if (div) Plotly.Plots.resize(div);
    };

    proto._cleanupPhase2dFitDocListeners = function(plot) {
        if (plot._phase2dFitSelectionDocListeners) {
            document.removeEventListener('mousemove', plot._phase2dFitSelectionDocListeners.move);
            document.removeEventListener('mouseup', plot._phase2dFitSelectionDocListeners.up);
            plot._phase2dFitSelectionDocListeners = null;
        }
        if (plot._phase2dFitSplitterDocListeners) {
            document.removeEventListener('mousemove', plot._phase2dFitSplitterDocListeners.move);
            document.removeEventListener('mouseup', plot._phase2dFitSplitterDocListeners.up);
            plot._phase2dFitSplitterDocListeners = null;
        }
        clearTimeout(plot._phase2dFitRecomputeTimer);
        clearTimeout(plot._phase2dFitVisualTimer);
    };

    // ── Temporal pane: X(t) solid + Y(t) dashed, one per pair ───────
    proto._phase2dFitTimeDescriptors = function(plot) {
        const out = [];
        (plot.phaseTraces || []).forEach((pair, idx) => {
            if (pair.visible === false) return;
            out.push({ varName: pair.x, fileId: pair.fileId, color: pair.color, dash: 'solid', role: 'X', pairIndex: idx });
            out.push({ varName: pair.y, fileId: pair.fileId, color: pair.color, dash: '5px,1px', role: 'Y', pairIndex: idx });
        });
        return out;
    };

    proto._buildPhase2dFitTimeTraces = function(plot) {
        const descriptors = this._phase2dFitTimeDescriptors(plot);
        const plotLike = { ...plot, traces: descriptors, timeseriesStacked: false, timeseriesY2Enabled: false };
        return descriptors.map((d, idx) => {
            const built = this._buildTimeTrace(d, null, plotLike, idx);
            if (!built) return null;
            if (built.type === 'scattergl') built.type = 'scatter';
            built.line = { ...(built.line || {}), color: d.color, dash: d.dash };
            built.name = `P${d.pairIndex + 1}·${d.role}: ${this._traceName(d.varName, d.fileId)}`;
            return built;
        }).filter(Boolean);
    };

    proto._buildPhase2dFitTimeLayout = function(plot) {
        const descriptors = this._phase2dFitTimeDescriptors(plot);
        const plotLike = { ...plot, traces: descriptors, timeseriesStacked: false, timeseriesY2Enabled: false };
        const layout = this._buildTimeLayout(plotLike);
        layout.shapes = this._phase2dFitSelectionShapes(plot);
        layout.margin = { ...(layout.margin || {}), t: 8 };
        layout.hovermode = 'closest';
        return layout;
    };

    proto._refreshPhase2dFitTimePlot = function(panelId, plot = this.plots.get(panelId), options = {}) {
        const timeDiv = plot?.phase2dFitTimeDiv;
        if (!timeDiv) return Promise.resolve();
        const xRange = options.preserveView ? timeDiv._fullLayout?.xaxis?.range : null;
        const yRange = (options.preserveView && options.preserveY !== false) ? timeDiv._fullLayout?.yaxis?.range : null;
        const layout = this._buildPhase2dFitTimeLayout(plot);
        if (Array.isArray(xRange)) layout.xaxis = { ...(layout.xaxis || {}), range: xRange, autorange: false };
        if (Array.isArray(yRange)) layout.yaxis = { ...(layout.yaxis || {}), range: yRange, autorange: false };
        return Plotly.react(timeDiv, this._buildPhase2dFitTimeTraces(plot), layout, this._getPlotlyConfig());
    };

    proto._refreshPhase2dFitTimeVisuals = function(panelId, plot = this.plots.get(panelId), range = null) {
        const timeDiv = plot?.phase2dFitTimeDiv;
        if (!timeDiv) return;
        const descriptors = this._phase2dFitTimeDescriptors(plot);
        if (!descriptors.length) return;
        const plotLike = { ...plot, traces: descriptors, timeseriesStacked: false, timeseriesY2Enabled: false };
        const xs = [], ys = [], indices = [];
        let plotIdx = 0;
        for (const d of descriptors) {
            const built = this._buildTimeTrace(d, range, plotLike, plotIdx);
            if (!built) continue;
            xs.push(built.x);
            ys.push(built.y);
            indices.push(plotIdx);
            plotIdx++;
        }
        if (indices.length) Plotly.restyle(timeDiv, { x: xs, y: ys }, indices);
    };

    proto._autoScalePhase2dFitTime = function(plot) {
        const timeDiv = plot?.phase2dFitTimeDiv;
        if (timeDiv) Plotly.relayout(timeDiv, { 'xaxis.autorange': true, 'yaxis.autorange': true });
    };

    // ── Temporal domain / active range (Todo/Selección) ─────────────
    proto._phase2dFitDomain = function(plot) {
        const arrays = [];
        const seen = new Set();
        for (const pair of plot?.phaseTraces || []) {
            if (seen.has(pair.fileId)) continue;
            seen.add(pair.fileId);
            const xTimes = this._getTransformedTimeDataForVariable(pair.fileId, pair.x);
            const yTimes = this._getTransformedTimeDataForVariable(pair.fileId, pair.y);
            if (xTimes?.length) arrays.push(xTimes);
            if (yTimes?.length) arrays.push(yTimes);
        }
        const extent = this._finiteExtent(arrays);
        return extent ? { min: extent.min, max: extent.max } : null;
    };

    proto._phase2dFitActiveRange = function(plot) {
        const state = this._ensurePhase2dState(plot);
        const domain = this._phase2dFitDomain(plot);
        if (state.rangeFull) {
            if (domain && Number.isFinite(domain.min) && Number.isFinite(domain.max)) return [domain.min, domain.max];
            return [0, 1];
        }
        let lo = p2dFiniteOrNull(state.x1);
        let hi = p2dFiniteOrNull(state.x2);
        if (lo === null || hi === null) { lo = domain?.min; hi = domain?.max; }
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
        if (lo > hi) [lo, hi] = [hi, lo];
        if (domain) {
            lo = Math.max(domain.min, Math.min(domain.max, lo));
            hi = Math.max(domain.min, Math.min(domain.max, hi));
        }
        return [lo, hi];
    };

    proto._ensurePhase2dFitRange = function(plot, options = {}) {
        const state = this._ensurePhase2dState(plot);
        const domain = this._phase2dFitDomain(plot);
        if (!domain) return state;
        if (options.reset || state.x1 === null || state.x2 === null) {
            state.x1 = domain.min;
            state.x2 = domain.max;
        }
        state.x1 = Math.max(domain.min, Math.min(domain.max, Number(state.x1)));
        state.x2 = Math.max(domain.min, Math.min(domain.max, Number(state.x2)));
        return state;
    };

    proto._phase2dFitUsesCalendarTime = function(plot) {
        const pair = (plot?.phaseTraces || []).find(p => p.visible !== false) || plot?.phaseTraces?.[0];
        return pair ? this._fftTimeKind(pair.fileId) === 'datetime' : false;
    };

    // ── Selection band (orange) on the temporal pane ────────────────
    proto._phase2dFitSelectionShapes = function(plot) {
        if (this._ensurePhase2dState(plot).rangeFull) return [];
        const [lo, hi] = this._phase2dFitActiveRange(plot);
        const firstPair = plot.phaseTraces?.[0];
        const timeVar = firstPair ? this._getTimeVar(firstPair.fileId) : null;
        const x0 = firstPair ? this._plotlyTimeValue(firstPair.fileId, lo, timeVar) : lo;
        const x1 = firstPair ? this._plotlyTimeValue(firstPair.fileId, hi, timeVar) : hi;
        const color = '#ff9800';
        return [
            { type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1, fillcolor: 'rgba(255, 152, 0, 0.12)', line: { width: 0 }, layer: 'below' },
            { type: 'line', xref: 'x', yref: 'paper', x0, x1: x0, y0: 0, y1: 1, line: { color, width: 2 } },
            { type: 'line', xref: 'x', yref: 'paper', x0: x1, x1, y0: 0, y1: 1, line: { color, width: 2 } },
        ];
    };

    proto._updatePhase2dFitSelectionShapes = function(panelId, plot = this.plots.get(panelId)) {
        const timeDiv = plot?.phase2dFitTimeDiv;
        if (timeDiv) Plotly.relayout(timeDiv, { shapes: this._phase2dFitSelectionShapes(plot) });
    };

    proto._installPhase2dFitSelectionHandlers = function(panelId, plot) {
        const timeDiv = plot?.phase2dFitTimeDiv;
        if (!timeDiv || plot._phase2dFitSelectionDiv === timeDiv) return;
        plot._phase2dFitSelectionDiv = timeDiv;
        let dragging = null;
        const hitTest = (event) => {
            if (this._ensurePhase2dState(plot).rangeFull) return null;
            if (!this._eventInsidePlotArea(timeDiv, event)) return null;
            const x = this._eventToXValue(timeDiv, event);
            if (!Number.isFinite(x)) return null;
            const domain = this._phase2dFitDomain(plot);
            if (!domain) return null;
            const [lo, hi] = this._phase2dFitActiveRange(plot);
            const xa = timeDiv._fullLayout?.xaxis;
            const span = Math.abs(this._coerceAxisValue(xa?.range?.[1]) - this._coerceAxisValue(xa?.range?.[0])) || Math.abs(hi - lo) || 1;
            const tol = Math.max((12 / (xa?._length || 1)) * span, span * 1e-6);
            if (Math.abs(x - lo) <= tol) return 'left';
            if (Math.abs(x - hi) <= tol) return 'right';
            const domainSpan = Math.abs(domain.max - domain.min) || 1;
            if (x >= lo && x <= hi && Math.abs(hi - lo) < domainSpan - tol) return 'move';
            return null;
        };
        timeDiv.addEventListener('mousemove', event => {
            if (dragging) return;
            const hit = hitTest(event);
            timeDiv.classList.toggle('fft-cursor-ew', hit === 'left' || hit === 'right');
            timeDiv.classList.toggle('fft-cursor-grab', hit === 'move');
        });
        timeDiv.addEventListener('mousedown', event => {
            if (event.button !== 0) return;
            const hit = hitTest(event);
            if (!hit) return;
            const x = this._eventToXValue(timeDiv, event);
            const [lo, hi] = this._phase2dFitActiveRange(plot);
            dragging = { hit, startX: x, startLo: lo, startHi: hi };
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            document.body.classList.add('fft-selection-dragging');
        }, true);
        const onMove = event => {
            if (!dragging || !timeDiv) return;
            const domain = this._phase2dFitDomain(plot);
            const x = this._eventToXValue(timeDiv, event);
            if (!Number.isFinite(x) || !domain) return;
            const state = this._ensurePhase2dState(plot);
            let lo = dragging.startLo, hi = dragging.startHi;
            if (dragging.hit === 'left') lo = x;
            else if (dragging.hit === 'right') hi = x;
            else {
                let delta = x - dragging.startX;
                if (dragging.startLo + delta < domain.min) delta = domain.min - dragging.startLo;
                if (dragging.startHi + delta > domain.max) delta = domain.max - dragging.startHi;
                lo = dragging.startLo + delta; hi = dragging.startHi + delta;
            }
            if (lo > hi) [lo, hi] = [hi, lo];
            state.x1 = Math.max(domain.min, Math.min(domain.max, lo));
            state.x2 = Math.max(domain.min, Math.min(domain.max, hi));
            this._updatePhase2dFitSelectionShapes(panelId, plot);
            this._syncPhase2dFitRangeInputs(plot);
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = null;
            document.body.classList.remove('fft-selection-dragging');
            timeDiv.classList.remove('fft-cursor-ew', 'fft-cursor-grab');
            this._schedulePhase2dFitRecompute(panelId);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        plot._phase2dFitSelectionDocListeners = { move: onMove, up: onUp };
    };

    proto._installPhase2dFitSplitterHandlers = function(panelId, plot) {
        const splitter = plot.phase2dFitContainer?.querySelector('.fft-splitter');
        if (!splitter || splitter._phase2dFitBound) return;
        splitter._phase2dFitBound = true;
        let dragging = false;
        const apply = (event) => {
            const container = plot.phase2dFitContainer;
            if (!container) return;
            const state = this._ensurePhase2dState(plot);
            const horizontal = state.layout === 'horizontal';
            const rect = container.querySelector('.fft-plot-area').getBoundingClientRect();
            const frac = horizontal
                ? (event.clientX - rect.left) / (rect.width || 1)
                : (event.clientY - rect.top) / (rect.height || 1);
            const split = Math.max(0.2, Math.min(0.8, frac));
            state.split = split;
            container.style.setProperty('--fft-split', `${Math.round(split * 1000) / 10}%`);
            if (plot.phase2dFitTimeDiv) Plotly.Plots.resize(plot.phase2dFitTimeDiv);
            if (plot.div) Plotly.Plots.resize(plot.div);
        };
        splitter.addEventListener('mousedown', event => { dragging = true; event.preventDefault(); document.body.classList.add('fft-split-dragging'); });
        const onMove = event => { if (dragging) apply(event); };
        const onUp = () => { dragging = false; document.body.classList.remove('fft-split-dragging'); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        plot._phase2dFitSplitterDocListeners = { move: onMove, up: onUp };
    };

    // ── Topbar handlers ─────────────────────────────────────────────
    proto._setPhase2dFitLayout = function(panelId, layout) {
        const plot = this.plots.get(panelId);
        if (!plot?.phase2dFitContainer || !PHASE2D_FIT_LAYOUTS.has(layout)) return;
        this._ensurePhase2dState(plot).layout = layout;
        plot.phase2dFitContainer.classList.toggle('fft-layout-horizontal', layout === 'horizontal');
        plot.phase2dFitContainer.classList.toggle('fft-layout-vertical', layout === 'vertical');
        if (plot.phase2dFitTimeDiv) Plotly.Plots.resize(plot.phase2dFitTimeDiv);
        if (plot.div) Plotly.Plots.resize(plot.div);
    };

    proto._togglePhase2dOptions = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot?.phase2dFitContainer) return;
        const state = this._ensurePhase2dState(plot);
        state.optionsVisible = !state.optionsVisible;
        if (plot.phase2dFitOptions) plot.phase2dFitOptions.hidden = !state.optionsVisible;
        const btn = plot.phase2dFitContainer.querySelector('.fft-options-btn');
        if (btn) {
            btn.classList.toggle('active', state.optionsVisible);
            btn.setAttribute('aria-pressed', String(state.optionsVisible));
        }
        if (plot.phase2dFitTimeDiv) Plotly.Plots.resize(plot.phase2dFitTimeDiv);
        if (plot.div) Plotly.Plots.resize(plot.div);
    };

    proto._resetPhase2dFitView = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot?.phase2dFitContainer) return;
        const state = this._ensurePhase2dState(plot);
        state.rangeFull = true;
        state.x1 = null;
        state.x2 = null;
        this._refreshPhase2dFitTimePlot(panelId, plot);
        this._autoScalePhase2dFitTime(plot);
        // 2D pane back to autoscale (respecting 1:1) + recompute over all rows.
        if (plot.div) Plotly.relayout(plot.div, { 'xaxis.autorange': true, 'yaxis.autorange': true });
        this._schedulePhase2dFitRecompute(panelId, { immediate: true });
        this._renderPhase2dFitDrawer(panelId, plot);
    };

    proto._setPhase2dFitStatus = function(plot, message, type = 'muted') {
        const el = plot?.phase2dFitContainer?.querySelector('.fft-status');
        if (!el) return;
        el.textContent = message || '';
        el.className = `fft-status fft-status-${type}`;
        el.title = message || '';
    };

    // Debounced recompute of the fits (curves + coefficients + drawer) after a
    // Todo/Selección range change. Eager only for now.
    proto._schedulePhase2dFitRecompute = function(panelId, options = {}) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'phase2d') return;
        clearTimeout(plot._phase2dFitRecomputeTimer);
        const run = () => {
            this._rerenderPhase2dPlot(panelId, plot);
            this._renderPhase2dFitDrawer(panelId, plot);
        };
        if (options.immediate) run();
        else plot._phase2dFitRecomputeTimer = setTimeout(run, 150);
    };

    // Localised, compact equation string for a fit result.
    proto._phase2dFitEquationText = function(fit) {
        if (!fit || fit.status !== 'ok') return '—';
        const g = (v) => {
            if (!Number.isFinite(v)) return 'N/A';
            const a = Math.abs(v);
            return (a !== 0 && (a < 1e-3 || a >= 1e5)) ? v.toExponential(4) : v.toPrecision(5);
        };
        const sign = (v) => (v < 0 ? '−' : '+');
        if (fit.model === 'linear') {
            return `y = ${g(fit.b1)}·x ${sign(fit.b0)} ${g(Math.abs(fit.b0))}`;
        }
        return `y = ${g(fit.a)}·x² ${sign(fit.b)} ${g(Math.abs(fit.b))}·x ${sign(fit.c)} ${g(Math.abs(fit.c))}`;
    };

    proto._phase2dFitWarningText = function(fit, lazy) {
        if (lazy) return i18n.t('phase2dFitLazyPending');
        if (!fit) return i18n.t('phase2dFitNoData');
        const map = {
            'insufficient-n': i18n.t('phase2dFitInsufficientN'),
            'x-constant': i18n.t('phase2dFitXConstant'),
            'y-constant': i18n.t('phase2dFitYConstant'),
            'singular': i18n.t('phase2dFitSingular'),
        };
        return fit.warning ? (map[fit.warning] || fit.warning) : '';
    };

    // Render the options/results drawer inside the shell: Todo/Selección range
    // controls, model help + one block per pair with the equation, r/R², RMSE,
    // N and any per-pair warning.
    proto._renderPhase2dFitDrawer = function(panelId, plot = this.plots.get(panelId)) {
        const drawer = plot?.phase2dFitOptions;
        if (!drawer) return;
        const state = this._ensurePhase2dState(plot);
        const results = this._computePhase2dFits(plot);
        const fmt = (v, d = 4) => (Number.isFinite(v) ? v.toPrecision(d) : 'N/A');

        drawer.replaceChildren();

        // ── Temporal range: Todo / Selección (mirrors FFT/Correlation) ──
        const domain = this._phase2dFitDomain(plot);
        const usesCalendar = this._phase2dFitUsesCalendarTime(plot);
        const makeRow = (labelText, control, tooltip = '') => {
            const label = document.createElement('label');
            label.className = 'fft-option-row';
            if (tooltip) label.title = tooltip;
            const span = document.createElement('span');
            span.textContent = labelText;
            label.append(span, control);
            return label;
        };
        const seedSelectionFromView = () => {
            const xa = plot.phase2dFitTimeDiv?._fullLayout?.xaxis;
            let lo = this._coerceAxisValue(xa?.range?.[0]);
            let hi = this._coerceAxisValue(xa?.range?.[1]);
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = domain?.min; hi = domain?.max; }
            if (Number.isFinite(lo) && Number.isFinite(hi)) {
                if (lo > hi) [lo, hi] = [hi, lo];
                if (domain) { lo = Math.max(domain.min, Math.min(domain.max, lo)); hi = Math.max(domain.min, Math.min(domain.max, hi)); }
                state.x1 = lo; state.x2 = hi;
            }
            this._ensurePhase2dFitRange(plot);
        };
        const makeSegment = (labelKey, tooltipKey, isFull) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = i18n.t(labelKey);
            btn.title = i18n.t(tooltipKey);
            btn.classList.toggle('active', !!state.rangeFull === isFull);
            btn.addEventListener('click', (event) => {
                event.preventDefault();
                if (!!state.rangeFull === isFull) return;
                state.rangeFull = isFull;
                if (!isFull) seedSelectionFromView();
                this._updatePhase2dFitSelectionShapes(panelId, plot);
                this._schedulePhase2dFitRecompute(panelId, { immediate: true });
                this._renderPhase2dFitDrawer(panelId, plot);
            });
            return btn;
        };
        const makeInput = (key) => {
            const input = document.createElement('input');
            input.type = usesCalendar ? 'datetime-local' : 'number';
            input.step = usesCalendar ? '1' : 'any';
            input.className = 'fft-number-input';
            input.dataset.p2dKey = key;
            input.value = usesCalendar ? p2dMsToDatetimeInput(state[key]) : p2dFormatInputValue(state[key]);
            input.disabled = !!state.rangeFull;
            input.addEventListener('change', () => {
                const n = usesCalendar ? p2dDatetimeInputToMs(input.value) : Number(input.value);
                state[key] = Number.isFinite(n) ? n : null;
                this._ensurePhase2dFitRange(plot);
                this._updatePhase2dFitSelectionShapes(panelId, plot);
                this._schedulePhase2dFitRecompute(panelId, { immediate: true });
                this._syncPhase2dFitRangeInputs(plot);
            });
            return input;
        };
        const makeRange = (key) => {
            const input = document.createElement('input');
            input.type = 'range';
            input.className = 'fft-range-input';
            input.dataset.p2dKey = key;
            if (domain) { input.min = String(domain.min); input.max = String(domain.max); input.step = 'any'; }
            input.value = Number.isFinite(Number(state[key])) ? String(Number(state[key])) : '';
            input.disabled = !!state.rangeFull;
            input.addEventListener('input', () => {
                const n = Number(input.value);
                state[key] = Number.isFinite(n) ? n : null;
                this._syncPhase2dFitRangeInputs(plot, { skipSliders: true });
                this._updatePhase2dFitSelectionShapes(panelId, plot);
            });
            input.addEventListener('change', () => this._schedulePhase2dFitRecompute(panelId));
            return input;
        };
        const segmented = document.createElement('div');
        segmented.className = 'fft-segmented';
        segmented.append(
            makeSegment('fftRangeFull', 'fftRangeFullTooltip', true),
            makeSegment('fftRangeSelection', 'fftRangeSelectionTooltip', false),
        );
        drawer.appendChild(makeRow(i18n.t('fftRange'), segmented));

        const rangeGrid = document.createElement('div');
        rangeGrid.className = 'fft-range-grid';
        const makeBound = (labelText, key, tooltip) => {
            const wrap = document.createElement('div');
            wrap.className = 'fft-range-bound';
            if (usesCalendar) wrap.classList.add('fft-range-bound-datetime');
            const slider = makeRange(key);
            slider.title = tooltip;
            wrap.append(makeRow(labelText, makeInput(key), tooltip), slider);
            return wrap;
        };
        rangeGrid.append(
            makeBound(i18n.t('fftRangeStart'), 'x1', i18n.t('fftRangeStartTooltip')),
            makeBound(i18n.t('fftRangeEnd'), 'x2', i18n.t('fftRangeEndTooltip')),
        );
        drawer.appendChild(rangeGrid);

        const title = document.createElement('h3');
        title.className = 'phase2d-fit-drawer-title';
        title.textContent = i18n.t('phase2dFitResultsTitle');
        drawer.appendChild(title);

        const help = document.createElement('p');
        help.className = 'phase2d-fit-help';
        help.textContent = i18n.t('phase2dFitOlsHelp');
        drawer.appendChild(help);

        // showEquation toggle.
        const eqLabel = document.createElement('label');
        eqLabel.className = 'phase2d-fit-eq-toggle';
        const eqCheck = document.createElement('input');
        eqCheck.type = 'checkbox';
        eqCheck.checked = state.showEquation !== false;
        eqCheck.addEventListener('change', () => {
            state.showEquation = eqCheck.checked;
            this._renderPhase2dFitDrawer(panelId, plot);
        });
        eqLabel.append(eqCheck, document.createTextNode(' ' + i18n.t('phase2dFitShowEquation')));
        drawer.appendChild(eqLabel);

        if (!results.length) {
            const empty = document.createElement('p');
            empty.className = 'phase2d-fit-empty';
            empty.textContent = i18n.t('phase2dFitNoPairs');
            drawer.appendChild(empty);
            return;
        }

        for (const r of results) {
            const block = document.createElement('div');
            block.className = 'phase2d-fit-result';

            const head = document.createElement('div');
            head.className = 'phase2d-fit-result-head';
            const swatch = document.createElement('span');
            swatch.className = 'phase2d-fit-swatch';
            swatch.style.background = r.pair.color;
            const name = document.createElement('span');
            name.className = 'phase2d-fit-result-name';
            name.textContent = r.label;
            head.append(swatch, name);
            block.appendChild(head);

            const ok = r.fit && r.fit.status === 'ok';
            if (state.showEquation !== false && ok) {
                const eq = document.createElement('div');
                eq.className = 'phase2d-fit-equation';
                eq.textContent = this._phase2dFitEquationText(r.fit);
                block.appendChild(eq);
            }

            if (ok) {
                const stats = document.createElement('dl');
                stats.className = 'phase2d-fit-stats';
                const rows = [];
                if (r.fit.model === 'linear') {
                    rows.push([i18n.t('phase2dFitPearsonR'), fmt(r.fit.r)]);
                }
                rows.push([i18n.t('phase2dFitRSquared'), fmt(r.fit.r2)]);
                rows.push([i18n.t('phase2dFitRmse'), fmt(r.fit.rmse)]);
                rows.push([i18n.t('phase2dFitN'), `${r.fit.n}${r.fit.nExcluded ? ` (−${r.fit.nExcluded})` : ''}`]);
                for (const [k, v] of rows) {
                    const dt = document.createElement('dt'); dt.textContent = k;
                    const dd = document.createElement('dd'); dd.textContent = v;
                    stats.append(dt, dd);
                }
                block.appendChild(stats);
            }

            const warn = this._phase2dFitWarningText(r.fit, r.lazy);
            if (warn) {
                const w = document.createElement('div');
                w.className = 'phase2d-fit-warning';
                w.setAttribute('role', 'alert');
                w.textContent = warn;
                block.appendChild(w);
            }
            drawer.appendChild(block);
        }
    };

    // Refresh the Start/End inputs + sliders from state without stealing focus.
    proto._syncPhase2dFitRangeInputs = function(plot, options = {}) {
        const panel = plot?.phase2dFitOptions;
        if (!panel) return;
        const state = this._ensurePhase2dState(plot);
        const usesCalendar = this._phase2dFitUsesCalendarTime(plot);
        for (const key of ['x1', 'x2']) {
            const num = panel.querySelector(`.fft-number-input[data-p2d-key="${key}"]`);
            if (num && document.activeElement !== num) {
                num.value = usesCalendar ? p2dMsToDatetimeInput(state[key]) : p2dFormatInputValue(state[key]);
            }
            if (!options.skipSliders) {
                const slider = panel.querySelector(`.fft-range-input[data-p2d-key="${key}"]`);
                if (slider && document.activeElement !== slider) {
                    slider.value = Number.isFinite(Number(state[key])) ? String(Number(state[key])) : '';
                }
            }
        }
    };
}
