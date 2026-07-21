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

        // Options drawer toggle — only meaningful while a fit is active.
        const optionsBtn = document.createElement('button');
        optionsBtn.type = 'button';
        optionsBtn.className = 'phase2d-fit-options-btn';
        optionsBtn.textContent = i18n.t('fftOptionsLabel');
        optionsBtn.title = i18n.t('fftOptionsToggle');
        optionsBtn.setAttribute('aria-pressed', String(state.optionsVisible));
        optionsBtn.classList.toggle('active', state.optionsVisible);
        optionsBtn.hidden = state.fitModel === 'none';
        optionsBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this._togglePhase2dOptions(panelId);
        });
        group.appendChild(optionsBtn);

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
            // Leave the origin cross and transient hover markers alone.
            if (!tr || tr.name === '__origin__' || tr.name === '__hover__') return;
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
    // are already applied by the transformed-data getters. rangeFull only for
    // now (temporal Todo/Selección comes in a later increment).
    proto._phase2dPairSeries = function(pair) {
        const xVals = this._getTransformedVariableData(pair.fileId, pair.x);
        const yVals = this._getTransformedVariableData(pair.fileId, pair.y);
        const n = Math.min(xVals?.length || 0, yVals?.length || 0);
        return { x: (xVals || []).slice(0, n), y: (yVals || []).slice(0, n), nScope: n };
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
            const series = this._phase2dPairSeries(pair);
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

    // ── Fit model change + re-render ────────────────────────────────
    proto._setPhase2dFitModel = function(panelId, model) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'phase2d') return;
        const state = this._ensurePhase2dState(plot);
        state.fitModel = PHASE2D_FIT_MODELS.has(model) ? model : 'none';
        const active = state.fitModel !== 'none';

        // Toggle the Options button visibility in the toolbar.
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        const optionsBtn = panelEl?.querySelector('.phase2d-fit-options-btn');
        if (optionsBtn) optionsBtn.hidden = !active;

        if (active) {
            this._ensurePhase2dFitDrawer(panelId, plot);
            this._renderPhase2dFitDrawer(panelId, plot);
        } else {
            this._removePhase2dFitDrawer(plot);
        }
        this._rerenderPhase2dPlot(panelId, plot);
    };

    // Re-render the 2D plot preserving the current view (fit changes must not
    // rescale). plot.div stays the same 2D div so 1:1 / autoscale / legend keep
    // working.
    proto._rerenderPhase2dPlot = function(panelId, plot = this.plots.get(panelId)) {
        if (!plot?.div || plot.mode !== 'phase2d') return Promise.resolve();
        const { traces, layout } = this._buildPlotData(plot);
        const xr = plot.div._fullLayout?.xaxis?.range;
        const yr = plot.div._fullLayout?.yaxis?.range;
        if (Array.isArray(xr)) layout.xaxis = { ...(layout.xaxis || {}), range: xr.slice(), autorange: false };
        if (Array.isArray(yr)) layout.yaxis = { ...(layout.yaxis || {}), range: yr.slice(), autorange: false };
        return Plotly.react(plot.div, traces, layout, this._getPlotlyConfig());
    };

    // ── Options / results drawer (FFT-like collapsible sidebar) ─────
    proto._togglePhase2dOptions = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'phase2d') return;
        const state = this._ensurePhase2dState(plot);
        state.optionsVisible = !state.optionsVisible;
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        const drawer = plot._phase2dFitDrawer || panelEl?.querySelector('.phase2d-fit-drawer');
        if (drawer) drawer.hidden = !state.optionsVisible;
        const optionsBtn = panelEl?.querySelector('.phase2d-fit-options-btn');
        if (optionsBtn) {
            optionsBtn.classList.toggle('active', state.optionsVisible);
            optionsBtn.setAttribute('aria-pressed', String(state.optionsVisible));
        }
    };

    proto._ensurePhase2dFitDrawer = function(panelId, plot = this.plots.get(panelId)) {
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!panelEl) return null;
        let drawer = plot._phase2dFitDrawer;
        if (drawer && drawer.isConnected) return drawer;
        drawer = panelEl.querySelector('.phase2d-fit-drawer');
        if (!drawer) {
            drawer = document.createElement('aside');
            drawer.className = 'phase2d-fit-drawer fft-options';
            drawer.setAttribute('aria-label', i18n.t('phase2dFitResultsTitle'));
            panelEl.appendChild(drawer);
        }
        plot._phase2dFitDrawer = drawer;
        drawer.hidden = !this._ensurePhase2dState(plot).optionsVisible;
        return drawer;
    };

    proto._removePhase2dFitDrawer = function(plot) {
        const drawer = plot?._phase2dFitDrawer;
        if (drawer && drawer.parentNode) drawer.parentNode.removeChild(drawer);
        plot._phase2dFitDrawer = null;
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

    // Render the results drawer: model help + one block per pair with the
    // equation, r/R², RMSE, N and any per-pair warning.
    proto._renderPhase2dFitDrawer = function(panelId, plot = this.plots.get(panelId)) {
        const drawer = this._ensurePhase2dFitDrawer(panelId, plot);
        if (!drawer) return;
        const state = this._ensurePhase2dState(plot);
        const results = this._computePhase2dFits(plot);
        const fmt = (v, d = 4) => (Number.isFinite(v) ? v.toPrecision(d) : 'N/A');

        drawer.replaceChildren();

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
}
