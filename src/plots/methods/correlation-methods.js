import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';
import Modal from '../../ui/modal.js';
import {
    pearsonCorrelation,
    CORRELATION_MANY_PAIRS_WARNING,
    CORRELATION_MAX_PAIRS,
} from '../../utils/correlation.js';

// Pearson formula in native MathML — real fraction and radicals, no LaTeX
// renderer or dependency (MathML Core is supported by Chromium/Electron and
// modern browsers). Shown in the "?" help modal.
const PEARSON_FORMULA_HTML = `
<math xmlns="http://www.w3.org/1998/Math/MathML" display="block" class="corr-math">
  <mi>r</mi><mo>=</mo>
  <mfrac>
    <mrow>
      <mo>&#8721;</mo>
      <mrow><mo>(</mo><msub><mi>x</mi><mi>i</mi></msub><mo>&#8722;</mo><mover><mi>x</mi><mo>&#8254;</mo></mover><mo>)</mo></mrow>
      <mrow><mo>(</mo><msub><mi>y</mi><mi>i</mi></msub><mo>&#8722;</mo><mover><mi>y</mi><mo>&#8254;</mo></mover><mo>)</mo></mrow>
    </mrow>
    <mrow>
      <msqrt><mrow><mo>&#8721;</mo><msup><mrow><mo>(</mo><msub><mi>x</mi><mi>i</mi></msub><mo>&#8722;</mo><mover><mi>x</mi><mo>&#8254;</mo></mover><mo>)</mo></mrow><mn>2</mn></msup></mrow></msqrt>
      <mo>&#8901;</mo>
      <msqrt><mrow><mo>&#8721;</mo><msup><mrow><mo>(</mo><msub><mi>y</mi><mi>i</mi></msub><mo>&#8722;</mo><mover><mi>y</mi><mo>&#8254;</mo></mover><mo>)</mo></mrow><mn>2</mn></msup></mrow></msqrt>
    </mrow>
  </mfrac>
</math>`;

const CORRELATION_LAYOUTS = new Set(['horizontal', 'vertical']);
const finiteOrNull = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

// Range-input formatting mirrors the FFT panel so the two look/behave the same.
// Display-only rounding; state keeps full precision.
const formatInputValue = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    if (n !== 0 && Math.abs(n) < 0.01) return n.toExponential(2);
    return String(Number(n.toFixed(2)));
};
// Calendar axes store epoch ms as naive UTC; the datetime-local pickers use the
// same UTC convention so they match the axis tick labels.
const msToDatetimeInput = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n)) return '';
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 19);
};
const datetimeInputToMs = (text) => {
    if (!text) return NaN;
    const ms = Date.parse(`${text}Z`);
    return Number.isFinite(ms) ? ms : NaN;
};

// The Correlation analysis mode: a temporal plot (variables that make up the
// pairs) + a horizontal bar plot of Pearson r per pair, in an FFT-style shell.
// Pairs live in plot.phaseTraces / plot.phasePending (shared with phase2d);
// this module owns only the correlation state, shell and eager compute.
export function installPlotCorrelationMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // ── State ──────────────────────────────────────────────────────
    proto._defaultCorrelationState = function() {
        return {
            layout: 'vertical',
            split: 0.5,
            timeSeriesHidden: false,
            optionsVisible: true,
            rangeFull: true,
            x1: null,
            x2: null,
            method: 'pearson',
            warnings: [],
            dirty: false,
        };
    };

    proto._normalizeCorrelationState = function(raw = {}) {
        const defaults = this._defaultCorrelationState();
        const layout = CORRELATION_LAYOUTS.has(raw.layout) ? raw.layout : defaults.layout;
        const split = Number(raw.split);
        const x1 = finiteOrNull(raw.x1);
        const x2 = finiteOrNull(raw.x2);
        return {
            ...defaults,
            ...raw,
            layout,
            split: Number.isFinite(split) ? Math.max(0.2, Math.min(0.8, split)) : defaults.split,
            timeSeriesHidden: raw.timeSeriesHidden === true,
            optionsVisible: raw.optionsVisible !== false,
            rangeFull: raw.rangeFull !== undefined ? !!raw.rangeFull : !(x1 !== null || x2 !== null),
            x1,
            x2,
            method: 'pearson',
            warnings: Array.isArray(raw.warnings) ? raw.warnings.slice(0, 20) : [],
            dirty: !!raw.dirty,
        };
    };

    proto._ensureCorrelationState = function(plot) {
        if (!plot) return this._defaultCorrelationState();
        if (!plot.correlation) {
            plot.correlation = this._normalizeCorrelationState({});
            return plot.correlation;
        }
        Object.assign(plot.correlation, this._normalizeCorrelationState(plot.correlation));
        return plot.correlation;
    };

    // ── Domain / active range (over the files that own the pairs) ──
    proto._correlationDomain = function(plot) {
        const arrays = [];
        const seen = new Set();
        for (const pair of plot?.phaseTraces || []) {
            if (seen.has(pair.fileId)) continue;
            seen.add(pair.fileId);
            const times = this._getTransformedTimeData(pair.fileId);
            if (times?.length) arrays.push(times);
        }
        const extent = this._finiteExtent(arrays);
        return extent ? { min: extent.min, max: extent.max } : null;
    };

    proto._activeCorrelationRange = function(plot) {
        const state = this._ensureCorrelationState(plot);
        const domain = this._correlationDomain(plot);
        if (state.rangeFull) {
            if (domain && Number.isFinite(domain.min) && Number.isFinite(domain.max)) return [domain.min, domain.max];
            return [0, 1];
        }
        let lo = finiteOrNull(state.x1);
        let hi = finiteOrNull(state.x2);
        if (lo === null || hi === null) { lo = domain?.min; hi = domain?.max; }
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
        if (lo > hi) [lo, hi] = [hi, lo];
        if (domain) {
            lo = Math.max(domain.min, Math.min(domain.max, lo));
            hi = Math.max(domain.min, Math.min(domain.max, hi));
        }
        return [lo, hi];
    };

    proto._ensureCorrelationRange = function(plot, options = {}) {
        const state = this._ensureCorrelationState(plot);
        const domain = this._correlationDomain(plot);
        if (!domain) return state;
        if (options.reset || state.x1 === null || state.x2 === null) {
            state.x1 = domain.min;
            state.x2 = domain.max;
        }
        state.x1 = Math.max(domain.min, Math.min(domain.max, Number(state.x1)));
        state.x2 = Math.max(domain.min, Math.min(domain.max, Number(state.x2)));
        return state;
    };

    // ── Chart creation ─────────────────────────────────────────────
    proto._createCorrelationChart = function(panelId, panelEl) {
        const plot = this.plots.get(panelId);
        if (!this._hasContent(plot)) return;
        const state = this._ensureCorrelationState(plot);

        const placeholder = panelEl.querySelector('.layout-panel-placeholder');
        if (placeholder) placeholder.style.display = 'none';
        panelEl.querySelector('.correlation-container')?.remove();

        // Reuse the FFT shell CSS (fft-container et al.); the extra
        // correlation-container marker lets _destroyChart target it cleanly.
        const container = document.createElement('div');
        container.className = `fft-container correlation-container fft-layout-${state.layout}${state.timeSeriesHidden ? ' fft-time-series-hidden' : ''}`;
        container.style.setProperty('--fft-split', `${Math.round(state.split * 1000) / 10}%`);

        const makeButton = (className, text, title, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = className;
            button.textContent = text;
            button.title = title;
            button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
            return button;
        };

        const topbar = document.createElement('div');
        topbar.className = 'fft-topbar';
        const layoutGroup = document.createElement('div');
        layoutGroup.className = 'fft-topbar-group';
        const timeSeriesBtn = makeButton(
            'fft-tool-btn fft-time-series-btn',
            i18n.t('hideTimeSeries'),
            i18n.t('hideTimeSeriesTooltip'),
            () => this._toggleCorrelationTimeSeries(panelId),
        );
        timeSeriesBtn.classList.toggle('active', state.timeSeriesHidden);
        timeSeriesBtn.setAttribute('aria-pressed', String(state.timeSeriesHidden));
        const layoutBtn = makeButton('fft-tool-btn', 'V/H', i18n.t('fftLayoutToggle'), () => {
            const current = this._ensureCorrelationState(plot).layout;
            this._setCorrelationLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
        });
        layoutBtn.setAttribute('aria-label', i18n.t('fftLayoutToggle'));
        layoutGroup.append(layoutBtn, timeSeriesBtn);
        const actionGroup = document.createElement('div');
        actionGroup.className = 'fft-topbar-group';
        const optionsBtn = makeButton('fft-tool-btn fft-options-btn', i18n.t('fftOptionsLabel'), i18n.t('fftOptionsToggle'), () => this._toggleCorrelationOptions(panelId));
        optionsBtn.classList.toggle('active', state.optionsVisible);
        optionsBtn.setAttribute('aria-pressed', String(state.optionsVisible));
        // Shown only while a lazy (DuckDB) pair is stale after a live append —
        // re-running the aggregate query every poll would be too costly, so the
        // user triggers the recompute (mirrors the Heatmap's Update button).
        const refreshBtn = makeButton('fft-tool-btn correlation-refresh-btn', i18n.t('correlationRefresh'), i18n.t('correlationRefreshTooltip'), () => this._refreshDirtyCorrelation(panelId));
        refreshBtn.hidden = !state.dirty;
        actionGroup.append(
            makeButton('fft-tool-btn', i18n.t('fftResetLabel'), i18n.t('fftResetView'), () => this._resetCorrelationView(panelId)),
            refreshBtn,
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
        const resultPane = document.createElement('div');
        resultPane.className = 'fft-pane fft-spectrum-pane';
        const splitter = document.createElement('div');
        splitter.className = 'fft-splitter';
        splitter.setAttribute('role', 'separator');

        const timeDiv = document.createElement('div');
        timeDiv.className = 'plotly-container plotly-mode-correlation-time';
        const resultDiv = document.createElement('div');
        resultDiv.className = 'plotly-container plotly-mode-correlation-result';
        timePane.appendChild(timeDiv);
        resultPane.appendChild(resultDiv);
        plotArea.append(timePane, splitter, resultPane);

        const options = document.createElement('aside');
        options.className = 'fft-options correlation-options';
        options.hidden = !state.optionsVisible;
        workspace.append(plotArea, options);
        container.append(topbar, workspace);
        panelEl.appendChild(container);

        plot.correlationContainer = container;
        plot.correlationDiv = resultDiv;
        plot.div = timeDiv;

        this._renderCorrelationOptionsPanel(panelId, plot);

        const config = this._getPlotlyConfig();
        Promise.all([
            Plotly.newPlot(timeDiv, this._buildCorrelationTimeTraces(plot), this._buildCorrelationTimeLayout(plot), config),
            Plotly.newPlot(resultDiv, [], this._buildCorrelationResultLayout(plot, []), config),
        ]).then(() => {
            this._refreshActionBtns(panelId);
            // Selection shapes are anchored in data-x, so Plotly repositions them
            // on zoom/pan automatically — no relayout listener needed (and one
            // would loop against our own shapes relayout).
            plot.div.on('plotly_doubleclick', () => { this._autoScaleCorrelationTime(plot); return false; });
            // Zoom/pan on the time pane -> re-fit the downsampling to the window.
            // Only x-axis changes matter; a shapes-only relayout is ignored so
            // this never loops against _updateCorrelationSelectionShapes.
            plot.div.on('plotly_relayout', (ed) => {
                const touchesX = ed && (
                    ed['xaxis.autorange'] !== undefined
                    || ed['xaxis.range'] !== undefined
                    || ed['xaxis.range[0]'] !== undefined
                    || ed['xaxis.range[1]'] !== undefined
                );
                if (!touchesX) return;
                clearTimeout(plot._corrVisualTimer);
                plot._corrVisualTimer = setTimeout(() => {
                    const r = plot.div?._fullLayout?.xaxis?.range;
                    this._refreshCorrelationTimeVisuals(panelId, plot, Array.isArray(r) ? r : null);
                }, 120);
            });
            // Results pane double-click: restore the fixed r range and the pair
            // order. Plotly's default autorange would drop 'reversed' and flip
            // P1..Pn vertically, so re-apply it explicitly and suppress default.
            plot.correlationDiv.on('plotly_doubleclick', () => {
                Plotly.relayout(plot.correlationDiv, { 'xaxis.range': [-1, 1], 'yaxis.autorange': 'reversed' });
                return false;
            });
            this._installCorrelationSelectionHandlers(panelId, plot);
            this._installCorrelationSplitterHandlers(panelId, plot);
            // Same pan gestures as the FFT/Histogram time pane: two-finger
            // trackpad swipe pans horizontally, right-button drag pans too. No
            // finalize: panning is view-only (the analyzed range is the Selection,
            // not the zoom), so nothing needs recomputing.
            this._installWheelPan(panelId, plot, plot.div, {});
            this._installRightButtonPan(panelId, plot, plot.div, {});
            // Same gestures on the results (bars) pane, like the FFT spectrum pane.
            this._installWheelPan(panelId, plot, plot.correlationDiv, {});
            this._installRightButtonPan(panelId, plot, plot.correlationDiv, {});
            this._scheduleCorrelationRecompute(panelId, { immediate: true });
            let timer;
            const ro = new ResizeObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    if (plot.div) Plotly.Plots.resize(plot.div);
                    if (plot.correlationDiv) Plotly.Plots.resize(plot.correlationDiv);
                }, 50);
            });
            ro.observe(panelEl);
            plot.resizeObserver = ro;
        });
    };

    // Called after a pair is added/removed/edited while the chart exists.
    proto._updateCorrelationChart = function(panelId, plot = this.plots.get(panelId)) {
        if (!plot?.div || plot.mode !== 'correlation') return;
        // Keep the time zoom (X) but re-fit Y so newly added variables are always
        // visible without the user having to autoscale by hand.
        this._refreshCorrelationTimePlot(panelId, plot, { preserveView: true, preserveY: false });
        this._renderCorrelationOptionsPanel(panelId, plot);
        this._scheduleCorrelationRecompute(panelId, { immediate: true });
    };

    // ── Temporal plot: one trace per (pair, role) so colours track pairs ──
    proto._correlationTimeDescriptors = function(plot) {
        const out = [];
        (plot.phaseTraces || []).forEach((pair, idx) => {
            if (pair.visible === false) return;
            out.push({ varName: pair.x, fileId: pair.fileId, color: pair.color, dash: 'solid', role: 'X', pairIndex: idx });
            // 5px dash / 1px gap (Y trace). Custom dash arrays only render on the
            // SVG renderer, so the traces are forced to 'scatter' below.
            out.push({ varName: pair.y, fileId: pair.fileId, color: pair.color, dash: '5px,1px', role: 'Y', pairIndex: idx });
        });
        return out;
    };

    proto._buildCorrelationTimeTraces = function(plot) {
        const descriptors = this._correlationTimeDescriptors(plot);
        const plotLike = { ...plot, traces: descriptors, timeseriesStacked: false, timeseriesY2Enabled: false };
        return descriptors.map((d, idx) => {
            const built = this._buildTimeTrace(d, null, plotLike, idx);
            if (!built) return null;
            // Force SVG so the custom dash pattern renders (scattergl ignores it);
            // the pane is downsampled to ~2000 points, so SVG is cheap.
            if (built.type === 'scattergl') built.type = 'scatter';
            built.line = { ...(built.line || {}), color: d.color, dash: d.dash };
            built.name = `P${d.pairIndex + 1}·${d.role}: ${this._traceName(d.varName, d.fileId)}`;
            return built;
        }).filter(Boolean);
    };

    // Re-fit the downsampling to the visible x-window (restyle x/y only), like
    // the timeseries/FFT panes do — otherwise a zoom keeps the coarse full-range
    // ~2000-point decimation and looks blocky when zoomed in.
    proto._refreshCorrelationTimeVisuals = function(panelId, plot = this.plots.get(panelId), range = null) {
        if (!plot?.div || plot.mode !== 'correlation') return;
        const descriptors = this._correlationTimeDescriptors(plot);
        if (!descriptors.length) return;
        const plotLike = { ...plot, traces: descriptors, timeseriesStacked: false, timeseriesY2Enabled: false };
        const xs = [], ys = [], indices = [];
        let plotIdx = 0; // must track the same null-filtering as _buildCorrelationTimeTraces
        for (const d of descriptors) {
            const built = this._buildTimeTrace(d, range, plotLike, plotIdx);
            if (!built) continue;
            xs.push(built.x);
            ys.push(built.y);
            indices.push(plotIdx);
            plotIdx++;
        }
        if (indices.length) Plotly.restyle(plot.div, { x: xs, y: ys }, indices);
    };

    proto._buildCorrelationTimeLayout = function(plot) {
        const descriptors = this._correlationTimeDescriptors(plot);
        const plotLike = { ...plot, traces: descriptors, timeseriesStacked: false, timeseriesY2Enabled: false };
        const layout = this._buildTimeLayout(plotLike);
        layout.shapes = this._correlationSelectionShapes(plot);
        layout.margin = { ...(layout.margin || {}), t: 8 };
        layout.hovermode = 'closest';
        return layout;
    };

    proto._refreshCorrelationTimePlot = function(panelId, plot = this.plots.get(panelId), options = {}) {
        if (!plot?.div || plot.mode !== 'correlation') return Promise.resolve();
        const xRange = options.preserveView ? plot.div._fullLayout?.xaxis?.range : null;
        // preserveY === false leaves Y on autorange so it expands to new traces.
        const yRange = (options.preserveView && options.preserveY !== false) ? plot.div._fullLayout?.yaxis?.range : null;
        const layout = this._buildCorrelationTimeLayout(plot);
        if (Array.isArray(xRange)) layout.xaxis = { ...(layout.xaxis || {}), range: xRange, autorange: false };
        if (Array.isArray(yRange)) layout.yaxis = { ...(layout.yaxis || {}), range: yRange, autorange: false };
        return Plotly.react(plot.div, this._buildCorrelationTimeTraces(plot), layout, this._getPlotlyConfig());
    };

    // ── Selection (orange band + draggable edges), FFT-style ──
    proto._correlationSelectionShapes = function(plot) {
        if (this._ensureCorrelationState(plot).rangeFull) return [];
        const [lo, hi] = this._activeCorrelationRange(plot);
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

    proto._updateCorrelationSelectionShapes = function(panelId, plot = this.plots.get(panelId)) {
        if (!plot?.div || plot.mode !== 'correlation') return;
        Plotly.relayout(plot.div, { shapes: this._correlationSelectionShapes(plot) });
    };

    proto._installCorrelationSelectionHandlers = function(panelId, plot) {
        if (!plot?.div || plot._correlationSelectionDiv === plot.div) return;
        plot._correlationSelectionDiv = plot.div;
        let dragging = null;
        const hitTest = (event) => {
            if (this._ensureCorrelationState(plot).rangeFull) return null;
            if (!this._eventInsidePlotArea(plot.div, event)) return null;
            const x = this._eventToXValue(plot.div, event);
            if (!Number.isFinite(x)) return null;
            const domain = this._correlationDomain(plot);
            if (!domain) return null;
            const [lo, hi] = this._activeCorrelationRange(plot);
            const xa = plot.div._fullLayout?.xaxis;
            const span = Math.abs(this._coerceAxisValue(xa?.range?.[1]) - this._coerceAxisValue(xa?.range?.[0])) || Math.abs(hi - lo) || 1;
            const tol = Math.max((12 / (xa?._length || 1)) * span, span * 1e-6);
            if (Math.abs(x - lo) <= tol) return 'left';
            if (Math.abs(x - hi) <= tol) return 'right';
            const domainSpan = Math.abs(domain.max - domain.min) || 1;
            if (x >= lo && x <= hi && Math.abs(hi - lo) < domainSpan - tol) return 'move';
            return null;
        };
        plot.div.addEventListener('mousemove', event => {
            if (dragging) return;
            const hit = hitTest(event);
            plot.div.classList.toggle('fft-cursor-ew', hit === 'left' || hit === 'right');
            plot.div.classList.toggle('fft-cursor-grab', hit === 'move');
        });
        plot.div.addEventListener('mousedown', event => {
            if (event.button !== 0) return;
            const hit = hitTest(event);
            if (!hit) return;
            const x = this._eventToXValue(plot.div, event);
            const [lo, hi] = this._activeCorrelationRange(plot);
            dragging = { hit, startX: x, startLo: lo, startHi: hi };
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            document.body.classList.add('fft-selection-dragging');
        }, true);
        const onMove = event => {
            if (!dragging || !plot.div) return;
            const domain = this._correlationDomain(plot);
            const x = this._eventToXValue(plot.div, event);
            if (!Number.isFinite(x) || !domain) return;
            const state = this._ensureCorrelationState(plot);
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
            this._updateCorrelationSelectionShapes(panelId, plot);
            this._syncCorrelationRangeInputs(plot);
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = null;
            document.body.classList.remove('fft-selection-dragging');
            plot.div?.classList.remove('fft-cursor-ew', 'fft-cursor-grab');
            this._scheduleCorrelationRecompute(panelId);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        plot._correlationSelectionDocListeners = { move: onMove, up: onUp };
    };

    proto._installCorrelationSplitterHandlers = function(panelId, plot) {
        const splitter = plot.correlationContainer?.querySelector('.fft-splitter');
        if (!splitter || splitter._correlationBound) return;
        splitter._correlationBound = true;
        let dragging = false;
        const apply = (event) => {
            const container = plot.correlationContainer;
            if (!container) return;
            const state = this._ensureCorrelationState(plot);
            const horizontal = state.layout === 'horizontal';
            const rect = container.querySelector('.fft-plot-area').getBoundingClientRect();
            const frac = horizontal
                ? (event.clientX - rect.left) / (rect.width || 1)
                : (event.clientY - rect.top) / (rect.height || 1);
            const split = Math.max(0.2, Math.min(0.8, frac));
            state.split = split;
            container.style.setProperty('--fft-split', `${Math.round(split * 1000) / 10}%`);
            if (plot.div) Plotly.Plots.resize(plot.div);
            if (plot.correlationDiv) Plotly.Plots.resize(plot.correlationDiv);
        };
        splitter.addEventListener('mousedown', event => { dragging = true; event.preventDefault(); document.body.classList.add('fft-split-dragging'); });
        const onMove = event => { if (dragging) apply(event); };
        const onUp = () => { dragging = false; document.body.classList.remove('fft-split-dragging'); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        plot._correlationSplitterDocListeners = { move: onMove, up: onUp };
    };

    // ── Eager compute ──────────────────────────────────────────────
    // In Todo mode (rangeFull) every row participates; in Selección only rows
    // whose transformed time falls inside [lo, hi]. Value-level NaN/±Inf are
    // left for the kernel to exclude (and count).
    proto._correlationPairSeries = function(pair, range, rangeFull) {
        const times = this._getTransformedTimeData(pair.fileId);
        const xVals = this._getTransformedVariableData(pair.fileId, pair.x);
        const yVals = this._getTransformedVariableData(pair.fileId, pair.y);
        const n = Math.min(times?.length || 0, xVals?.length || 0, yVals?.length || 0);
        if (rangeFull) {
            return { x: xVals.slice(0, n), y: yVals.slice(0, n), nScope: n };
        }
        const [lo, hi] = range;
        const x = [], y = [];
        for (let i = 0; i < n; i++) {
            const t = Number(times[i]);
            if (t >= lo && t <= hi) { x.push(xVals[i]); y.push(yVals[i]); }
        }
        return { x, y, nScope: x.length };
    };

    proto._isLazyFile = function(fileId) {
        return !!this.files.get(fileId)?.data?._duckdb;
    };

    proto._scheduleCorrelationRecompute = function(panelId, options = {}) {
        const plot = this.plots.get(panelId);
        if (!plot?.correlationDiv || plot.mode !== 'correlation') return;
        clearTimeout(plot._correlationRecomputeTimer);
        const run = () => this._refreshCorrelationResults(panelId, plot);
        if (options.immediate) run();
        else plot._correlationRecomputeTimer = setTimeout(run, 150);
    };

    // ── Live-update dirty state (lazy pairs only; see updateFileData) ──
    proto._markCorrelationDirty = function(panelId, message = i18n.t('correlationDirty')) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'correlation') return;
        this._ensureCorrelationState(plot).dirty = true;
        this._syncCorrelationDirtyUi(plot);
        this._setCorrelationStatus(plot, message, 'warning');
    };

    proto._syncCorrelationDirtyUi = function(plot) {
        const state = this._ensureCorrelationState(plot);
        const button = plot?.correlationContainer?.querySelector('.correlation-refresh-btn');
        if (button) {
            button.hidden = !state.dirty;
            button.disabled = !state.dirty;
        }
    };

    proto._refreshDirtyCorrelation = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        this._ensureCorrelationState(plot).dirty = false;
        this._syncCorrelationDirtyUi(plot);
        // Pull the newly appended data into the time pane, then recompute r.
        this._refreshCorrelationTimePlot(panelId, plot, { preserveView: true, preserveY: false });
        this._scheduleCorrelationRecompute(panelId, { immediate: true });
    };

    proto._refreshCorrelationResults = async function(panelId, plot = this.plots.get(panelId)) {
        if (!plot?.correlationDiv || plot.mode !== 'correlation') return;
        const token = (plot._correlationToken || 0) + 1;
        plot._correlationToken = token;
        const state = this._ensureCorrelationState(plot);
        const pairs = (plot.phaseTraces || []).filter(p => p.visible !== false);
        if (!pairs.length) {
            this._setCorrelationStatus(plot, i18n.t('correlationNoPairs'), 'muted');
            Plotly.react(plot.correlationDiv, [], this._buildCorrelationResultLayout(plot, []), this._getPlotlyConfig());
            plot._correlationResults = [];
            this._renderCorrelationOptionsPanel(panelId, plot);
            return;
        }
        this._setCorrelationStatus(plot, i18n.t('correlationCalculating'), 'loading');
        const range = this._activeCorrelationRange(plot);
        const label = (pair) => `${this._traceName(pair.x, pair.fileId)} ↔ ${this._traceName(pair.y, pair.fileId)}`;
        const results = new Array(pairs.length);

        // Eager pairs compute synchronously; lazy pairs are grouped per file and
        // computed exactly in DuckDB (one aggregate query each, never overview).
        const lazyByFile = new Map();
        pairs.forEach((pair, index) => {
            if (this._isLazyFile(pair.fileId)) {
                if (!lazyByFile.has(pair.fileId)) lazyByFile.set(pair.fileId, []);
                lazyByFile.get(pair.fileId).push({ index, pair });
                return;
            }
            const series = this._correlationPairSeries(pair, range, state.rangeFull);
            const stats = pearsonCorrelation(series.x, series.y);
            results[index] = { pair, label: label(pair), nScope: series.nScope, ...stats };
        });

        if (lazyByFile.size) {
            const jobs = [...lazyByFile.entries()].map(async ([fileId, entries]) => {
                const data = this.files.get(fileId)?.data;
                const source = data?._duckdb?.source;
                if (!source?.getPairCorrelations) return { entries, error: true };
                const transform = this._fileTransform(fileId);
                const timeVar = this._getTimeVar(fileId);
                const sourceTimeRange = state.rangeFull ? null : this._sourceRangeForDisplayRange(fileId, range, timeVar);
                try {
                    const stats = await source.getPairCorrelations(
                        data,
                        entries.map(e => ({ x: e.pair.x, y: e.pair.y })),
                        { sourceTimeRange, gain: transform.gain, yOffset: transform.yOffset },
                    );
                    return { entries, stats };
                } catch (err) {
                    console.warn('[correlation] lazy query failed:', err);
                    return { entries, error: true };
                }
            });
            const settled = await Promise.all(jobs);
            if (plot._correlationToken !== token) return; // superseded while awaiting
            for (const { entries, stats, error } of settled) {
                entries.forEach((e, k) => {
                    const s = (!error && stats?.[k]) ? stats[k] : { status: 'error' };
                    results[e.index] = { pair: e.pair, label: label(e.pair), ...s, n: s.nPair ?? s.n };
                });
            }
        }

        if (plot._correlationToken !== token) return;

        const warnings = [];
        for (const r of results) {
            if (!r || r.status === 'ok') continue;
            if (r.status === 'undefined') warnings.push(`${r.label}: ${i18n.t('correlationUndefined')}`);
            else if (r.status === 'noSql' || r.status === 'noCorr') warnings.push(`${r.label}: ${i18n.t('correlationNoSql')}`);
            else warnings.push(`${r.label}: ${i18n.t('correlationLazyError')}`);
        }
        state.warnings = warnings;
        // A completed compute is by definition up to date, so drop any pending
        // live-append dirty flag (e.g. after a rebuild that ran while dirty).
        state.dirty = false;
        this._syncCorrelationDirtyUi(plot);
        plot._correlationResults = results;
        Plotly.react(plot.correlationDiv, this._buildCorrelationResultTraces(results), this._buildCorrelationResultLayout(plot, results), this._getPlotlyConfig());
        this._renderCorrelationOptionsPanel(panelId, plot);
        // Show the actual warning text (not just a count) so the user knows why;
        // it is also listed in the drawer. The topbar truncates with a tooltip.
        if (warnings.length) this._setCorrelationStatus(plot, warnings.join(' · '), 'warning');
        else this._setCorrelationStatus(plot, i18n.t('correlationReady'), 'ready');
    };

    // ── Result bars ────────────────────────────────────────────────
    proto._buildCorrelationResultTraces = function(results) {
        if (!results.length) return [];
        const labels = results.map((r, i) => `P${i + 1}`);
        const values = results.map(r => (r.status === 'ok' ? r.r : null));
        const colors = results.map(r => r.pair.color || '#888');
        const customdata = results.map(r => ([
            r.label,
            r.status === 'ok' ? r.r.toPrecision(6) : 'N/A',
            r.status === 'ok' ? r.r2.toPrecision(6) : 'N/A',
            r.n ?? 0,
            r.nExcluded ?? 0,
        ]));
        return [{
            type: 'bar',
            orientation: 'h',
            x: values,
            y: labels,
            marker: { color: colors },
            base: 0,
            width: 0.6,
            customdata,
            hovertemplate: '<b>%{customdata[0]}</b><br>'
                + `${i18n.t('correlationPearson')} = %{customdata[1]}<br>`
                + `r² = %{customdata[2]}<br>`
                + `N = %{customdata[3]} (${i18n.t('correlationExcludedShort')} %{customdata[4]})<extra></extra>`,
        }];
    };

    proto._buildCorrelationResultLayout = function(plot, results) {
        const { bg, gridColor, fontColor } = this._colors();
        const labels = results.map((r, i) => `P${i + 1}`);
        // N/A annotations for undefined pairs (a row with no bar).
        const annotations = results.map((r, i) => (r.status === 'ok' ? null : {
            xref: 'x', yref: 'y', x: 0, y: `P${i + 1}`,
            text: 'N/A',
            showarrow: false, font: { color: fontColor, size: 10 }, xanchor: 'left', xshift: 6,
        })).filter(Boolean);
        return {
            paper_bgcolor: bg, plot_bgcolor: bg,
            font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
            showlegend: false,
            margin: { l: 44, r: 12, t: 8, b: 34 },
            xaxis: {
                range: [-1, 1], zeroline: false, gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor,
                tickvals: [-1, -0.5, 0, 0.5, 1],
                title: { text: i18n.t('correlationPearson'), font: { size: 10 } },
            },
            yaxis: {
                type: 'category', automargin: true, autorange: 'reversed',
                gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor,
                categoryarray: labels,
            },
            shapes: [{ type: 'line', xref: 'x', yref: 'paper', x0: 0, x1: 0, y0: 0, y1: 1, line: { color: gridColor, width: 1.5 } }],
            annotations,
        };
    };

    // ── Topbar handlers ────────────────────────────────────────────
    proto._setCorrelationLayout = function(panelId, layout) {
        const plot = this.plots.get(panelId);
        if (!plot?.correlationContainer || !CORRELATION_LAYOUTS.has(layout)) return;
        this._ensureCorrelationState(plot).layout = layout;
        plot.correlationContainer.classList.toggle('fft-layout-horizontal', layout === 'horizontal');
        plot.correlationContainer.classList.toggle('fft-layout-vertical', layout === 'vertical');
        if (plot.div) Plotly.Plots.resize(plot.div);
        if (plot.correlationDiv) Plotly.Plots.resize(plot.correlationDiv);
    };

    proto._toggleCorrelationTimeSeries = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot?.correlationContainer) return;
        const state = this._ensureCorrelationState(plot);
        state.timeSeriesHidden = !state.timeSeriesHidden;
        plot.correlationContainer.classList.toggle('fft-time-series-hidden', state.timeSeriesHidden);
        const button = plot.correlationContainer.querySelector('.fft-time-series-btn');
        if (button) {
            button.classList.toggle('active', state.timeSeriesHidden);
            button.setAttribute('aria-pressed', String(state.timeSeriesHidden));
        }
        if (!state.timeSeriesHidden && plot.div) Plotly.Plots.resize(plot.div);
        if (plot.correlationDiv) Plotly.Plots.resize(plot.correlationDiv);
    };

    proto._toggleCorrelationOptions = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot?.correlationContainer) return;
        const state = this._ensureCorrelationState(plot);
        state.optionsVisible = !state.optionsVisible;
        const options = plot.correlationContainer.querySelector('.correlation-options');
        if (options) options.hidden = !state.optionsVisible;
        const btn = plot.correlationContainer.querySelector('.fft-options-btn');
        if (btn) {
            btn.classList.toggle('active', state.optionsVisible);
            btn.setAttribute('aria-pressed', String(state.optionsVisible));
        }
        if (plot.div) Plotly.Plots.resize(plot.div);
        if (plot.correlationDiv) Plotly.Plots.resize(plot.correlationDiv);
    };

    proto._resetCorrelationView = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot?.div) return;
        const state = this._ensureCorrelationState(plot);
        state.rangeFull = true;
        state.x1 = null;
        state.x2 = null;
        this._refreshCorrelationTimePlot(panelId, plot);
        this._autoScaleCorrelationTime(plot);
        this._scheduleCorrelationRecompute(panelId, { immediate: true });
        this._renderCorrelationOptionsPanel(panelId, plot);
    };

    proto._autoScaleCorrelationTime = function(plot) {
        if (!plot?.div) return;
        Plotly.relayout(plot.div, { 'xaxis.autorange': true, 'yaxis.autorange': true });
    };

    proto._setCorrelationStatus = function(plot, message, type = 'muted') {
        const el = plot?.correlationContainer?.querySelector('.fft-status');
        if (!el) return;
        el.textContent = message || '';
        el.className = `fft-status fft-status-${type}`;
        el.title = message || '';
    };

    // ── Right drawer (options panel) ───────────────────────────────
    proto._renderCorrelationOptionsPanel = function(panelId, plot = this.plots.get(panelId)) {
        const panel = plot?.correlationContainer?.querySelector('.correlation-options');
        if (!panel) return;
        const state = this._ensureCorrelationState(plot);
        const results = plot._correlationResults || [];
        panel.replaceChildren();

        const section = (titleKey) => {
            const s = document.createElement('div');
            s.className = 'fft-options-section';
            const h = document.createElement('h4');
            h.textContent = i18n.t(titleKey);
            s.appendChild(h);
            return s;
        };

        // Warnings box (why a pair shows N/A or lazy), so "1 ⚠" is never opaque.
        if (state.warnings?.length) {
            const box = document.createElement('div');
            box.className = 'correlation-message';
            for (const w of state.warnings) {
                const line = document.createElement('div');
                line.textContent = `⚠ ${w}`;
                box.appendChild(line);
            }
            panel.appendChild(box);
        }

        // Range section — identical DOM/classes to FFT/Histogram (segmented
        // Full/Selection control + Start/End rows with number inputs and sliders).
        const domain = this._correlationDomain(plot);
        const usesCalendar = this._correlationUsesCalendarTime(plot);
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
            const xa = plot.div?._fullLayout?.xaxis;
            let lo = this._coerceAxisValue(xa?.range?.[0]);
            let hi = this._coerceAxisValue(xa?.range?.[1]);
            if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = domain?.min; hi = domain?.max; }
            if (Number.isFinite(lo) && Number.isFinite(hi)) {
                if (lo > hi) [lo, hi] = [hi, lo];
                if (domain) { lo = Math.max(domain.min, Math.min(domain.max, lo)); hi = Math.max(domain.min, Math.min(domain.max, hi)); }
                state.x1 = lo; state.x2 = hi;
            }
            this._ensureCorrelationRange(plot);
        };
        const makeSegment = (labelKey, tooltipKey, isFull) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = i18n.t(labelKey);
            btn.title = i18n.t(tooltipKey);
            btn.classList.toggle('active', !!state.rangeFull === isFull);
            btn.addEventListener('click', (event) => {
                event.preventDefault();
                const st = this._ensureCorrelationState(plot);
                if (!!st.rangeFull === isFull) return;
                st.rangeFull = isFull;
                if (!isFull) seedSelectionFromView();
                this._updateCorrelationSelectionShapes(panelId, plot);
                this._scheduleCorrelationRecompute(panelId, { immediate: true });
                this._renderCorrelationOptionsPanel(panelId, plot);
            });
            return btn;
        };
        const makeInput = (key) => {
            const input = document.createElement('input');
            input.type = usesCalendar ? 'datetime-local' : 'number';
            input.step = usesCalendar ? '1' : 'any';
            input.className = 'fft-number-input';
            input.dataset.corrKey = key;
            input.value = usesCalendar ? msToDatetimeInput(state[key]) : formatInputValue(state[key]);
            input.disabled = !!state.rangeFull;
            input.addEventListener('change', () => {
                const st = this._ensureCorrelationState(plot);
                const n = usesCalendar ? datetimeInputToMs(input.value) : Number(input.value);
                st[key] = Number.isFinite(n) ? n : null;
                this._ensureCorrelationRange(plot);
                this._updateCorrelationSelectionShapes(panelId, plot);
                this._scheduleCorrelationRecompute(panelId, { immediate: true });
                this._syncCorrelationRangeInputs(plot);
            });
            return input;
        };
        const makeRange = (key) => {
            const input = document.createElement('input');
            input.type = 'range';
            input.className = 'fft-range-input';
            input.dataset.corrKey = key;
            if (domain) { input.min = String(domain.min); input.max = String(domain.max); input.step = 'any'; }
            input.value = Number.isFinite(Number(state[key])) ? String(Number(state[key])) : '';
            input.disabled = !!state.rangeFull;
            input.addEventListener('input', () => {
                const st = this._ensureCorrelationState(plot);
                const n = Number(input.value);
                st[key] = Number.isFinite(n) ? n : null;
                this._syncCorrelationRangeInputs(plot, { skipSliders: true });
                this._updateCorrelationSelectionShapes(panelId, plot);
            });
            input.addEventListener('change', () => this._scheduleCorrelationRecompute(panelId));
            return input;
        };
        const segmented = document.createElement('div');
        segmented.className = 'fft-segmented';
        segmented.append(
            makeSegment('fftRangeFull', 'fftRangeFullTooltip', true),
            makeSegment('fftRangeSelection', 'fftRangeSelectionTooltip', false),
        );
        panel.appendChild(makeRow(i18n.t('fftRange'), segmented));

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
        panel.appendChild(rangeGrid);

        // Pending pair hint
        const pending = plot.phasePending;
        if (pending?.x && !pending?.y) {
            const hint = document.createElement('div');
            hint.className = 'correlation-pending-hint';
            hint.textContent = i18n.t('correlationPendingY').replace('{x}', this._traceName(pending.x, pending.fileId));
            panel.appendChild(hint);
        }

        // Pair list
        const pairsSection = section('correlationPairsTitle');
        const pairs = plot.phaseTraces || [];
        if (pairs.length >= CORRELATION_MANY_PAIRS_WARNING) {
            const warn = document.createElement('div');
            warn.className = 'correlation-warning';
            warn.textContent = i18n.t('correlationManyPairs').replace('{n}', String(pairs.length));
            pairsSection.appendChild(warn);
        }
        const list = document.createElement('ol');
        list.className = 'correlation-pair-list';
        list.setAttribute('aria-label', i18n.t('correlationPairsTitle'));
        pairs.forEach((pair, idx) => {
            const li = document.createElement('li');
            li.className = 'correlation-pair-item';
            const swatch = document.createElement('span');
            swatch.className = 'correlation-pair-swatch';
            swatch.style.background = pair.color || '#888';
            swatch.setAttribute('aria-hidden', 'true'); // decorative colour key
            const pairLabel = `${this._traceName(pair.x, pair.fileId)} ↔ ${this._traceName(pair.y, pair.fileId)}`;
            const label = document.createElement('span');
            label.className = 'correlation-pair-label';
            label.textContent = pairLabel;
            const res = results[idx];
            const rVal = document.createElement('span');
            rVal.className = 'correlation-pair-r';
            rVal.textContent = res
                ? (res.status === 'ok' ? `r=${res.r.toFixed(4)}` : 'N/A')
                : '';
            // Icon-only buttons: title alone isn't reliably announced, so name
            // each action and scope it to its pair for screen-reader users.
            const invertBtn = document.createElement('button');
            invertBtn.type = 'button';
            invertBtn.className = 'correlation-pair-btn';
            invertBtn.textContent = '⇄';
            invertBtn.title = i18n.t('correlationInvert');
            invertBtn.setAttribute('aria-label', `${i18n.t('correlationInvert')}: ${pairLabel}`);
            invertBtn.addEventListener('click', () => this._invertCorrelationPair(panelId, idx));
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'correlation-pair-btn';
            removeBtn.textContent = '✕';
            removeBtn.title = i18n.t('correlationRemovePair');
            removeBtn.setAttribute('aria-label', `${i18n.t('correlationRemovePair')}: ${pairLabel}`);
            removeBtn.addEventListener('click', () => this._removeCorrelationPair(panelId, idx));
            li.append(swatch, label, rVal, invertBtn, removeBtn);
            list.appendChild(li);
        });
        if (pairs.length) pairsSection.appendChild(list);
        if (!pairs.length) {
            const empty = document.createElement('div');
            empty.className = 'correlation-empty';
            empty.textContent = i18n.t('correlationDropHint');
            pairsSection.appendChild(empty);
        }
        panel.appendChild(pairsSection);

        // Pearson help: just a "?" button next to the section title; the full
        // explanation (formula + text) lives in the modal it opens.
        const helpSection = section('correlationHelpTitle');
        const helpBtn = document.createElement('button');
        helpBtn.type = 'button';
        helpBtn.className = 'fft-help-btn';
        helpBtn.textContent = '?';
        helpBtn.title = i18n.t('correlationHelpMore');
        helpBtn.setAttribute('aria-label', i18n.t('correlationHelpMore'));
        helpBtn.addEventListener('click', () => this._showCorrelationHelp());
        helpSection.querySelector('h4').appendChild(helpBtn);
        panel.appendChild(helpSection);
    };

    proto._showCorrelationHelp = function() {
        const body = `${PEARSON_FORMULA_HTML}<div class="correlation-help-modal">${i18n.t('correlationHelpModalBody')}</div>`;
        Modal.alert(i18n.t('correlationHelpTitle'), body, {
            html: true,
            icon: false,
            className: 'correlation-help-dialog',
        });
    };

    proto._syncCorrelationRangeInputs = function(plot, options = {}) {
        const panel = plot?.correlationContainer?.querySelector('.correlation-options');
        if (!panel) return;
        const state = this._ensureCorrelationState(plot);
        const usesCalendar = this._correlationUsesCalendarTime(plot);
        for (const key of ['x1', 'x2']) {
            const num = panel.querySelector(`.fft-number-input[data-corr-key="${key}"]`);
            if (num && document.activeElement !== num) {
                num.value = usesCalendar ? msToDatetimeInput(state[key]) : formatInputValue(state[key]);
            }
            if (!options.skipSliders) {
                const slider = panel.querySelector(`.fft-range-input[data-corr-key="${key}"]`);
                if (slider && document.activeElement !== slider) {
                    slider.value = Number.isFinite(Number(state[key])) ? String(Number(state[key])) : '';
                }
            }
        }
    };

    proto._correlationUsesCalendarTime = function(plot) {
        const pair = (plot?.phaseTraces || []).find(p => p.visible !== false) || plot?.phaseTraces?.[0];
        return pair ? this._fftTimeKind(pair.fileId) === 'datetime' : false;
    };

    proto._removeCorrelationPair = function(panelId, index) {
        const plot = this.plots.get(panelId);
        if (!plot || !Array.isArray(plot.phaseTraces)) return;
        if (index < 0 || index >= plot.phaseTraces.length) return;
        plot.phaseTraces.splice(index, 1);
        if (!plot.phaseTraces.length) { this._clearPanel(panelId); return; }
        this._updateCorrelationChart(panelId, plot);
    };

    proto._invertCorrelationPair = function(panelId, index) {
        const plot = this.plots.get(panelId);
        const pair = plot?.phaseTraces?.[index];
        if (!pair) return;
        [pair.x, pair.y] = [pair.y, pair.x];
        this._updateCorrelationChart(panelId, plot);
    };
}
