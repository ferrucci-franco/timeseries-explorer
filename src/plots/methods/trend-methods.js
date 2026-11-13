import i18n from '../../i18n/index.js';
import { createEdgeToggle, syncEdgeToggle } from '../../ui/edge-toggle.js';
import Plotly from '../../vendor/plotly.js';
import Modal from '../../ui/modal.js';
import { createCopyButton } from '../../ui/copy-button.js';
import { fitEquationParts, formatFitCoefficient } from '../../utils/fit-models.js';
import { seedTrendBand } from '../../utils/trend-fit.js';
import { csvValueCell } from '../../utils/csv-cell.js';
import {
    TREND_CURVES,
    TREND_EXP_OPTIONS,
    TREND_LAYOUTS,
    TREND_MAX_SEGMENTS,
    trendBandKeyMove,
    trendColor,
    trendSegmentBand,
} from '../trend-state.js';
import { CURVE_FIT_TIME_UNITS } from '../curve-fit-state.js';

// The Trend analysis of a time series: what each stretch of a signal is doing —
// its mean, how far it wanders from it, and the trend fitted through it.
//
// It answers the question a long record raises and a single fit cannot: a
// battery test is a charge, a rest and a discharge; a reactor run is a ramp, a
// plateau and a cool-down. Each stretch has a mean worth quoting and a slope
// worth quoting, and they only mean something side by side. So a panel holds a
// LIST of segments (plots/trend-state.js), each with its own signal, its own
// range and its own value band, and the pane under the time series is a TABLE:
// one row per segment, the numbers that change as its edges are dragged.
//
// Every segment always reports its mean, its linear trend and its quadratic
// trend — two passes of sums, which on a lazy file is one aggregate query per
// pass for every segment at once, so dragging a range stays answerable on a
// file of any size. The exponential is per segment and asked for explicitly:
// it is an iterative fit, and on a huge file a score of reads of the range.
//
// OUTLIERS. A segment can carry a value band: two dashed lines, dragged with
// the pointer, in the signal's own units. A sample outside them is left out of
// the mean and of every trend, and counted, so the table says how much the band
// took out. It is the Data tools' "remove outliers by bounds", applied to a
// reading instead of to the data.
//
// The computing is in trend-lazy-methods.js, which has no Plotly in it so a
// test can run it in Node against a real DuckDB-WASM engine.

const RECOMPUTE_DEBOUNCE_MS = 150;

// How each trend is drawn over the signal.
const CURVE_STYLE = {
    mean: { dash: 'dot', width: 2 },
    linear: { dash: 'dash', width: 2.5 },
    quadratic: { dash: 'dashdot', width: 2 },
    exp: { dash: 'longdash', width: 2 },
};
const CURVE_LABEL_KEY = {
    mean: 'trendCurveMean',
    linear: 'trendCurveLinear',
    quadratic: 'trendCurveQuadratic',
    exp: 'trendCurveExp',
};
// The value band's lines and the pointer that grabs them.
const BAND_COLOR = '#d81b60';
const BAND_GRAB_PX = 10;

const finiteOrNull = (value) => {
    if (value === '' || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};
const formatInputValue = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    if (n !== 0 && Math.abs(n) < 0.01) return n.toExponential(3);
    return String(Number(n.toPrecision(10)));
};
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
// Four significant digits for the table; 'N/A' for what is not a number.
const cell = (value) => (Number.isFinite(value) ? formatFitCoefficient(value) : '—');

export function installPlotTrendMethods(TargetClass) {
    const proto = TargetClass.prototype;

    proto._trendOptionsPanel = function(plot) {
        return plot?.trendOptionsEl || null;
    };

    // ── Adding signals ─────────────────────────────────────────────
    proto._addTrendTrace = function(panelId, varName, panelEl, plot) {
        if (plot.traces.find(trace => trace.varName === varName && trace.fileId === this.activeFileId)) return;
        if (!this._canAddTraceWithFileTime(plot, this.activeFileId)) return;
        plot.traces.push({
            varName,
            color: this._nextTraceColor(plot.traces),
            fileId: this.activeFileId,
            axis: 'y',
        });
        // The signal just dropped is the one the user means to read next.
        const segment = this._trendActiveSegment(plot);
        if (segment && !segment.varName) {
            segment.varName = varName;
            segment.fileId = this.activeFileId;
        }
        if (!plot.div) this._createTrendChart(panelId, panelEl);
        else this._refreshTrendAll(panelId, plot, { preserveView: true });
    };

    // ── Ranges ────────────────────────────────────────────────────
    // Seed a segment's selection from the time view: its middle third, so both
    // edges sit inside the plot where they can be grabbed.
    proto._seedTrendSelection = function(plot, segment) {
        const domain = this._trendDomain(plot);
        const axis = plot?.div?._fullLayout?.xaxis;
        let lo = this._coerceAxisValue(axis?.range?.[0]);
        let hi = this._coerceAxisValue(axis?.range?.[1]);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = domain?.min; hi = domain?.max; }
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
        if (lo > hi) [lo, hi] = [hi, lo];
        if (domain) {
            lo = Math.max(domain.min, Math.min(domain.max, lo));
            hi = Math.max(domain.min, Math.min(domain.max, hi));
        }
        const third = (hi - lo) / 3;
        segment.x1 = lo + third;
        segment.x2 = hi - third;
    };

    proto._trendFormatTime = function(trace, value) {
        if (!Number.isFinite(value)) return 'N/A';
        if (trace && this._canonicalFftKind(trace.fileId) === 'datetime') {
            return this._formatCalendarDateTime(trace.fileId, value, this._getTimeVar(trace.fileId));
        }
        return formatFitCoefficient(value);
    };

    proto._trendUsesCalendar = function(plot) {
        const trace = (plot?.traces || []).find(t => this._isVisible(t)) || plot?.traces?.[0];
        return trace ? this._canonicalFftKind(trace.fileId) === 'datetime' : false;
    };

    // ── Recompute ─────────────────────────────────────────────────
    proto._scheduleTrendRecompute = function(panelId, options = {}) {
        const plot = this.plots.get(panelId);
        if (!plot?.div || plot.mode !== 'trend') return;
        clearTimeout(plot._trendRecomputeTimer);
        const run = () => {
            if (this.plots.get(panelId) !== plot || plot.mode !== 'trend' || !plot.div) return;
            this._setTrendStatus(plot, i18n.t('trendCalculating'), 'loading');
            this._runAnalysisAfterPaint(
                plot,
                '_trendRecomputeRun',
                () => plot.mode === 'trend' && !!plot.div,
                () => {
                    const results = this._computeTrends(plot);
                    this._paintTrends(panelId, plot, results);
                    this._refreshTrendLazy(panelId, plot, results);
                },
            );
        };
        if (options.immediate) run();
        else plot._trendRecomputeTimer = setTimeout(run, RECOMPUTE_DEBOUNCE_MS);
    };

    // What the lazy jobs call when one settles: redraw with what is known now.
    proto._afterTrendLazyJob = function(panelId, plot, { again = false } = {}) {
        if (this.plots.get(panelId) !== plot || plot.mode !== 'trend' || !plot.div) return;
        if (again) {
            this._scheduleTrendRecompute(panelId);
            return;
        }
        this._paintTrends(panelId, plot, this._computeTrends(plot));
    };

    // Draw what is known: the curves on the time pane, the table, the drawer
    // and the status line.
    proto._paintTrends = function(panelId, plot, results) {
        if (!plot?.div) return;
        this._replaceTrendTraces(plot, results);
        this._renderTrendTable(panelId, plot, results);
        this._renderTrendDrawer(panelId, plot, results);
        const done = results.filter(r => r.result).length;
        const pending = results.some(r => r.lazy && !r.result && r.lazyStatus === 'pending');
        const cancelled = results.some(r => r.lazy && !r.result && r.lazyStatus === 'cancelled');
        if (pending) this._setTrendStatus(plot, i18n.t('trendLazyPending'), 'loading');
        else if (cancelled) this._setTrendStatus(plot, i18n.t(results.some(r => r.staleResult) ? 'analysisCancelledKept' : 'analysisCancelled'), 'muted');
        else this._setTrendStatus(plot, done ? i18n.t('trendStatus').replace('{count}', String(done)) : '', 'muted');
    };

    // The progress of a lazy segment, on the computing pill.
    proto._setTrendProgress = function(plot, kind, count, pass = 0) {
        if (!plot || plot.mode !== 'trend') return;
        const rows = i18n.formatNumber(Number(count) || 0);
        let text;
        if (kind === 'sums') text = i18n.t('trendLazySums').replace('{count}', rows);
        else if (kind === 'exp') text = i18n.t('trendLazyExp').replace('{pass}', String(pass)).replace('{rows}', rows);
        else text = i18n.t('trendLazyStream').replace('{pass}', String(pass)).replace('{rows}', rows);
        this._setTrendStatus(plot, text, 'loading');
    };

    // ── Time pane ─────────────────────────────────────────────────
    proto._buildTrendDataTraces = function(plot) {
        return plot.traces.map((trace, index) => this._buildTimeTrace(trace, null, plot, index)).filter(Boolean);
    };

    proto._buildTrendCurveTraces = function(plot, results = plot._trendResults || []) {
        const state = this._ensureTrendState(plot);
        const traces = [];
        for (const entry of results) {
            // What is drawn: this segment's trends, or while new ones are
            // computed (or after they were cancelled) the previous ones.
            const shown = entry.result || entry.staleResult || null;
            if (!shown || !entry.trace) continue;
            for (const kind of TREND_CURVES) {
                if (state.curves[kind] === false) continue;
                const curve = shown.curves?.[kind];
                if (!curve?.x?.length) continue;
                const label = kind === 'exp'
                    ? `${i18n.t(CURVE_LABEL_KEY.exp)} (${this._trendExpModelName(entry.segment.expModel)})`
                    : i18n.t(CURVE_LABEL_KEY[kind]);
                const name = `T${entry.index + 1} · ${label}`;
                const style = CURVE_STYLE[kind];
                traces.push({
                    x: curve.x,
                    y: curve.y,
                    type: 'scatter',
                    mode: 'lines',
                    name,
                    yaxis: this._traceYAxis(entry.trace, plot),
                    line: { color: entry.color, width: style.width, dash: style.dash },
                    customdata: curve.tPrime,
                    hovertemplate: `<b>${this._escapeHTML(name)}</b><br>t′ = %{customdata:.4g} ${this._escapeHTML(shown.unit || '')}`
                        + '<br>ŷ = %{y:.4g}<extra></extra>',
                    meta: { trendIndex: entry.index, trendCurve: kind },
                });
            }
        }
        return traces;
    };

    // The trend curves sit after the panel's own traces, so the time-series
    // refresh (which restyles by trace index) never reaches them.
    proto._replaceTrendTraces = function(plot, results) {
        // Chained: two paints in flight must not interleave their delete/add.
        const run = () => {
            const div = plot?.div;
            if (!div?.data || plot.mode !== 'trend') return Promise.resolve();
            const indices = [];
            div.data.forEach((trace, index) => { if (trace?.meta?.trendIndex !== undefined) indices.push(index); });
            const next = this._buildTrendCurveTraces(plot, results);
            const apply = () => (next.length && plot.div === div ? Plotly.addTraces(div, next) : null);
            return Promise.resolve(indices.length ? Plotly.deleteTraces(div, indices) : null)
                .then(apply)
                .then(() => this._updateTrendSelectionShapes(plot));
        };
        plot._trendPaintChain = Promise.resolve(plot._trendPaintChain).catch(() => {}).then(run);
        return plot._trendPaintChain;
    };

    proto._buildTrendTimeLayout = function(plot) {
        const layout = this._buildTimeLayout(plot);
        const overlay = this._trendSelectionOverlay(plot);
        layout.shapes = overlay.shapes;
        layout.annotations = [...(layout.annotations || []), ...overlay.annotations];
        layout.margin = { ...(layout.margin || {}), t: 18 };
        return layout;
    };

    // Every segment draws its range: the active one as the green band that can
    // be dragged, the others grey, each labelled T1, T2… The active segment's
    // value band, when it has one, is two dashed lines across it.
    proto._trendSelectionOverlay = function(plot) {
        const state = this._ensureTrendState(plot);
        const shapes = [];
        const annotations = [];
        const first = plot.traces?.[0];
        const timeVar = first ? this._getTimeVar(first.fileId) : null;
        const toX = (v) => (first ? this._plotlyTimeValue(first.fileId, v, timeVar) : v);
        state.segments.forEach((segment, index) => {
            const active = index === state.activeSegment;
            const [lo, hi] = this._trendRange(plot, segment);
            const x0 = toX(lo);
            const x1 = toX(hi);
            if (!segment.rangeFull) {
                if (active) {
                    const color = '#43a047';
                    shapes.push(
                        { type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1, fillcolor: 'rgba(67,160,71,0.14)', line: { width: 0 }, layer: 'below' },
                        { type: 'line', xref: 'x', yref: 'paper', x0, x1: x0, y0: 0, y1: 1, line: { color, width: 2 } },
                        { type: 'line', xref: 'x', yref: 'paper', x0: x1, x1, y0: 0, y1: 1, line: { color, width: 2 } },
                    );
                } else {
                    shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0, x1, y0: 0, y1: 1, fillcolor: 'rgba(128,128,128,0.10)', line: { width: 1, color: 'rgba(128,128,128,0.45)', dash: 'dot' }, layer: 'below' });
                }
            }
            const mid = lo + (hi - lo) / 2;
            annotations.push({
                xref: 'x', yref: 'paper', x: toX(mid), y: 1, yanchor: 'bottom', showarrow: false,
                text: `<b>T${index + 1}</b>`,
                font: { size: 11, color: active ? '#2e7d32' : trendColor(index) },
                _trendLabel: true,
            });
            // The value band: only the active segment's, so there is never a
            // doubt about which pair of lines the pointer grabs.
            if (!active) return;
            const band = trendSegmentBand(segment);
            if (!band) return;
            const trace = this._trendTraceFor(plot, segment);
            const yref = this._traceYAxis(trace, plot);
            for (const [side, value] of [['lower', band.lower], ['upper', band.upper]]) {
                if (!Number.isFinite(value)) continue;
                shapes.push({
                    type: 'line', xref: 'x', yref, x0, x1, y0: value, y1: value,
                    line: { color: BAND_COLOR, width: 1.6, dash: 'dash' },
                    _trendBand: side,
                });
                annotations.push({
                    xref: 'x', yref, x: x1, y: value, xanchor: 'right',
                    yanchor: side === 'upper' ? 'bottom' : 'top',
                    showarrow: false,
                    text: formatFitCoefficient(value),
                    font: { size: 10, color: BAND_COLOR },
                    _trendLabel: true,
                });
            }
        });
        return { shapes, annotations };
    };

    proto._updateTrendSelectionShapes = function(plot) {
        if (!plot?.div?._fullLayout || plot.mode !== 'trend') return Promise.resolve();
        const overlay = this._trendSelectionOverlay(plot);
        const kept = (plot.div.layout?.annotations || []).filter(a => !a._trendLabel && !/^<b>T\d+<\/b>$/.test(String(a.text || '')));
        return Plotly.relayout(plot.div, { shapes: overlay.shapes, annotations: [...kept, ...overlay.annotations] })
            .then(() => this._refreshTrendBandHandles(plot));
    };

    // ── The band's handles ────────────────────────────────────────
    /**
     * How far one press of an arrow key moves a bound: a hundredth of the
     * value axis as it is drawn, so a press is a small move on the screen
     * whatever the signal's units are — and ten presses cross a tenth of it.
     * Shift and the Page keys move ten steps at once.
     *
     * Without a laid-out axis (a panel that has not been drawn yet) the
     * segment's own spread stands in for it.
     */
    proto._trendBandStep = function(plot, segment, yref = 'y') {
        const key = yref === 'y2' ? 'yaxis2' : 'yaxis';
        const axis = plot?.div?._fullLayout?.[key];
        const lo = this._coerceAxisValue(axis?.range?.[0]);
        const hi = this._coerceAxisValue(axis?.range?.[1]);
        if (Number.isFinite(lo) && Number.isFinite(hi) && hi !== lo) return Math.abs(hi - lo) / 100;
        const r = (plot?._trendResults || []).find(candidate => candidate.segment === segment);
        const trend = (r?.result || r?.staleResult)?.trend;
        const std = Number(trend?.std);
        if (std > 0) return std / 10;
        const span = Number(trend?.maxY) - Number(trend?.minY);
        if (span > 0) return span / 100;
        const mean = Math.abs(Number(trend?.mean));
        return mean > 0 ? mean / 100 : 1;
    };

    // What the ends of a bound's travel are: the value axis as it is drawn.
    proto._trendBandRange = function(plot, yref = 'y') {
        const key = yref === 'y2' ? 'yaxis2' : 'yaxis';
        const axis = plot?.div?._fullLayout?.[key];
        const lo = this._coerceAxisValue(axis?.range?.[0]);
        const hi = this._coerceAxisValue(axis?.range?.[1]);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: NaN, max: NaN };
        return lo <= hi ? { min: lo, max: hi } : { min: hi, max: lo };
    };

    /**
     * A key press on a bound: the arrows (and Shift, Page, Home and End) move
     * it, anything else is left to the field or the button it was pressed on.
     * Returns true when the bound moved.
     *
     * `ends` is off in a text field, where Home and End belong to the caret;
     * `focusHandle` keeps the handle on the line under the finger of whoever
     * pressed it, and is off when the press came from the drawer's field.
     */
    proto._moveTrendBandByKey = function(panelId, which, event, { ends = true, focusHandle = true } = {}) {
        const plot = this.plots.get(panelId);
        const segment = plot ? this._trendActiveSegment(plot) : null;
        const band = segment ? trendSegmentBand(segment) : null;
        if (!band) return false;
        const trace = this._trendTraceFor(plot, segment);
        const yref = this._traceYAxis(trace, plot);
        if (!ends && (event.key === 'Home' || event.key === 'End')) return false;
        const { min, max } = this._trendBandRange(plot, yref);
        const next = trendBandKeyMove(event, {
            value: band[which],
            step: this._trendBandStep(plot, segment, yref),
            min,
            max,
        });
        if (next === null || !Number.isFinite(next)) return false;
        event.preventDefault();
        const other = which === 'upper' ? finiteOrNull(segment.lower) : finiteOrNull(segment.upper);
        const patch = { [which]: next };
        // A bound pushed past the other one swaps them, as dragging it does,
        // so the band never turns inside out and throws everything away.
        if (other !== null && ((which === 'upper' && next < other) || (which === 'lower' && next > other))) {
            patch[which] = other;
            patch[which === 'upper' ? 'lower' : 'upper'] = next;
        }
        this._updateTrendSegment(panelId, patch);
        // The handle the press came from keeps the focus, under its new value.
        if (focusHandle) this._refreshTrendBandHandles(plot, { focus: which });
        return true;
    };

    /**
     * The two handles of the active segment's band: a target on each line, at
     * the right end of the segment, that takes the pointer, the finger and the
     * keyboard. Each is announced as a slider over the value axis, so the
     * bounds can be placed without ever reaching for the drawer's fields.
     *
     * Placed in pixels, so they are re-placed whenever the plot is (a zoom, a
     * pan, a resize), like every other overlay the panel draws.
     */
    proto._refreshTrendBandHandles = function(plot, { focus = null } = {}) {
        const div = plot?.div;
        if (!div?.isConnected) return;
        let host = plot._trendBandHandles;
        if (host && host.parentElement !== div) { host.remove(); host = null; }
        const layout = div._fullLayout;
        const segment = plot.mode === 'trend' ? this._trendActiveSegment(plot) : null;
        const band = segment ? trendSegmentBand(segment) : null;
        if (!layout?.xaxis || !band) {
            host?.remove();
            plot._trendBandHandles = null;
            return;
        }
        if (!host) {
            host = document.createElement('div');
            host.className = 'trend-band-handles';
            div.appendChild(host);
            plot._trendBandHandles = host;
        }
        const trace = this._trendTraceFor(plot, segment);
        const yref = this._traceYAxis(trace, plot);
        const yAxis = layout[yref === 'y2' ? 'yaxis2' : 'yaxis'];
        const xAxis = layout.xaxis;
        if (!yAxis?.d2p || !xAxis?.d2p) { host.replaceChildren(); return; }
        const [lo, hi] = this._trendRange(plot, segment);
        const first = plot.traces?.[0];
        const timeVar = first ? this._getTimeVar(first.fileId) : null;
        const toX = (v) => (first ? this._plotlyTimeValue(first.fileId, v, timeVar) : v);
        const left = xAxis._offset || 0;
        const right = left + (xAxis._length || 0);
        const top = yAxis._offset || 0;
        const bottom = top + (yAxis._length || 0);
        // Just inside the segment's left edge: the right one carries the
        // bound's value, and the handle would sit on top of it there.
        const edge = Math.min(left + xAxis.d2p(toX(hi)), right);
        const start = Math.max(left + xAxis.d2p(toX(lo)), left);
        const x = Math.min(start + 18, Math.max(edge - 2, start + 2));
        const { min, max } = this._trendBandRange(plot, yref);
        const wanted = [];
        for (const which of ['upper', 'lower']) {
            const value = band[which];
            if (!Number.isFinite(value)) continue;
            const y = top + yAxis.d2p(value);
            if (!Number.isFinite(y)) continue;
            // A bound whose line is out of view leaves its handle at the edge
            // it went past, so it can be brought back instead of being lost
            // off screen — as a cursor's tab does (utils/cursor-handles.js).
            const edged = y < top ? 'above' : (y > bottom ? 'below' : null);
            wanted.push({ which, value, x, y: Math.max(top + 10, Math.min(bottom - 10, y)), edged });
        }
        const existing = new Map([...host.children].map(el => [el.dataset.bound, el]));
        for (const [which, el] of existing) {
            if (!wanted.some(handle => handle.which === which)) el.remove();
        }
        for (const { which, value, x: px, y, edged } of wanted) {
            let handle = existing.get(which);
            if (!handle) {
                handle = document.createElement('button');
                handle.type = 'button';
                handle.className = 'trend-band-handle';
                handle.dataset.bound = which;
                handle.setAttribute('role', 'slider');
                handle.setAttribute('aria-orientation', 'vertical');
                handle.addEventListener('keydown', (event) => {
                    const panelId = this._panelIdForPlot?.(plot);
                    if (panelId == null) return;
                    this._moveTrendBandByKey(panelId, which, event);
                });
                host.appendChild(handle);
            }
            handle.style.left = `${Math.round(px)}px`;
            handle.style.top = `${Math.round(y)}px`;
            handle.classList.toggle('trend-band-handle-edge', !!edged);
            if (edged) handle.dataset.edge = edged; else delete handle.dataset.edge;
            handle.title = i18n.t(which === 'upper' ? 'trendBandHandleUpper' : 'trendBandHandleLower');
            handle.setAttribute('aria-label', handle.title);
            handle.setAttribute('aria-valuenow', String(value));
            if (Number.isFinite(min)) handle.setAttribute('aria-valuemin', String(min));
            if (Number.isFinite(max)) handle.setAttribute('aria-valuemax', String(max));
            handle.setAttribute('aria-valuetext', formatFitCoefficient(value));
        }
        if (focus) host.querySelector(`.trend-band-handle[data-bound="${focus}"]`)?.focus({ preventScroll: true });
    };

    proto._refreshTrendAll = function(panelId, plot = this.plots.get(panelId), options = {}) {
        if (!plot?.div || plot.mode !== 'trend') return Promise.resolve();
        const xRange = options.preserveView ? plot.div._fullLayout?.xaxis?.range : null;
        const layout = this._buildTrendTimeLayout(plot);
        if (Array.isArray(xRange)) layout.xaxis = { ...(layout.xaxis || {}), range: xRange.slice(), autorange: false };
        const traces = [...this._buildTrendDataTraces(plot), ...this._buildTrendCurveTraces(plot)];
        return Plotly.react(plot.div, traces, layout, this._getPlotlyConfig()).then(() => {
            this._installLegendHoverHint?.(plot.div);
            this._refreshTimeseriesVisuals(panelId, plot);
            this._scheduleTrendRecompute(panelId, { immediate: true });
        });
    };

    // ── Chart ─────────────────────────────────────────────────────
    proto._createTrendChart = function(panelId, panelEl) {
        const plot = this.plots.get(panelId);
        if (!this._hasContent(plot)) return;
        const state = this._ensureTrendState(plot);
        const restoreView = plot._pendingViewRestore || null;
        delete plot._pendingViewRestore;
        this._consumeSessionViewRestore(plot);
        plot._trendCache = new Map();

        const placeholder = panelEl.querySelector('.layout-panel-placeholder');
        if (placeholder) placeholder.style.display = 'none';
        panelEl.querySelector('.trend-container')?.remove();

        const container = document.createElement('div');
        container.className = `fft-container trend-container fft-layout-${state.layout}${state.tableHidden ? ' trend-table-hidden' : ''}`;
        container.style.setProperty('--fft-split', `${Math.round(state.split * 1000) / 10}%`);

        const makeButton = (className, label, title, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = className;
            button.textContent = label;
            button.title = title;
            button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
            return button;
        };
        const topbar = document.createElement('div');
        topbar.className = 'fft-topbar';
        const layoutGroup = document.createElement('div');
        layoutGroup.className = 'fft-topbar-group';
        const layoutBtn = makeButton('fft-tool-btn', 'V/H', i18n.t('fftLayoutToggle'), () => {
            const current = this._ensureTrendState(plot).layout;
            this._setTrendLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
        });
        layoutBtn.setAttribute('aria-label', i18n.t('fftLayoutToggle'));
        const tableBtn = makeButton('fft-tool-btn trend-table-btn',
            i18n.t(state.tableHidden ? 'trendShowTable' : 'trendHideTable'),
            i18n.t('trendTableTooltip'),
            () => this._toggleTrendTable(panelId));
        tableBtn.classList.toggle('active', state.tableHidden);
        tableBtn.setAttribute('aria-pressed', String(state.tableHidden));
        layoutGroup.append(layoutBtn, tableBtn);
        const actionGroup = document.createElement('div');
        actionGroup.className = 'fft-topbar-group';
        const optionsBtn = makeButton('fft-tool-btn fft-options-btn', i18n.t('fftOptionsLabel'), i18n.t('fftOptionsToggle'), () => this._toggleTrendOptions(panelId));
        optionsBtn.classList.toggle('active', state.optionsVisible);
        optionsBtn.setAttribute('aria-pressed', String(state.optionsVisible));
        actionGroup.append(
            makeButton('fft-tool-btn', i18n.t('fftResetLabel'), i18n.t('fftResetView'), () => this._resetTrendView(panelId)),
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
        const tablePane = document.createElement('div');
        tablePane.className = 'fft-pane trend-table-pane';
        const splitter = document.createElement('div');
        splitter.className = 'fft-splitter';
        splitter.setAttribute('role', 'separator');
        const timeDiv = document.createElement('div');
        timeDiv.className = 'plotly-container plotly-mode-trend-time';
        const tableWrap = document.createElement('div');
        tableWrap.className = 'trend-table-wrap';
        tableWrap.setAttribute('role', 'region');
        tableWrap.setAttribute('aria-label', i18n.t('trendTableTitle'));
        timePane.appendChild(timeDiv);
        tablePane.appendChild(tableWrap);
        plotArea.append(timePane, splitter, tablePane);

        const options = document.createElement('aside');
        options.className = 'fft-options phase2d-fit-options trend-options';
        options.hidden = !state.optionsVisible;
        options.setAttribute('aria-label', i18n.t('trendOptionsTitle'));
        workspace.append(plotArea, createEdgeToggle({
            side: 'right',
            collapsed: !state.optionsVisible,
            hideKey: 'edgeHideOptions',
            showKey: 'edgeShowOptions',
            onToggle: () => this._toggleTrendOptions(panelId),
        }), options);
        container.append(topbar, workspace);
        panelEl.appendChild(container);

        plot.trendContainer = container;
        plot.trendTableEl = tableWrap;
        plot.trendOptionsEl = options;
        plot.div = timeDiv;
        plot._trendResults = [];
        this._renderTrendTable(panelId, plot, []);
        this._renderTrendDrawer(panelId, plot, []);

        Plotly.newPlot(timeDiv, this._buildTrendDataTraces(plot), this._buildTrendTimeLayout(plot), this._getPlotlyConfig()).then(() => {
            if (this.plots.get(panelId) !== plot || plot.div !== timeDiv) return;
            this._refreshActionBtns(panelId);
            this._installTrendPlotHandlers(panelId, plot);
            this._installCursorHandlers?.(panelId, plot);
            this._installTrendSelectionHandlers(panelId, plot);
            this._installTrendSplitterHandlers(panelId, plot);
            this._installWheelPan(panelId, plot, timeDiv, { finalize: xRange => this._onRelayout(panelId, { 'xaxis.range': xRange }) });
            this._installRightButtonPan(panelId, plot, timeDiv, { finalize: xRange => this._onRelayout(panelId, { 'xaxis.range': xRange }) });
            this._syncCursorDisplay?.(panelId, plot);
            const viewPromise = restoreView ? this._restorePlotView(plot, restoreView) : Promise.resolve();
            Promise.resolve(viewPromise).then(() => {
                this._refreshTimeseriesVisuals(panelId, plot);
                // A segment with no range yet is seeded once the view exists.
                const state2 = this._ensureTrendState(plot);
                let seeded = false;
                for (const segment of state2.segments) {
                    if (!segment.rangeFull && (segment.x1 === null || segment.x2 === null)) {
                        this._seedTrendSelection(plot, segment);
                        seeded = true;
                    }
                }
                if (seeded) this._updateTrendSelectionShapes(plot);
                this._bindViewHistory(panelId, plot);
                this._scheduleTrendRecompute(panelId, { immediate: true });
            });
            let timer;
            const observer = new ResizeObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    if (!plot.div?.isConnected) return;
                    Promise.resolve(Plotly.Plots.resize(plot.div))
                        .then(() => this._refreshTrendBandHandles(plot))
                        .catch(() => {});
                }, 50);
            });
            observer.observe(panelEl);
            plot.resizeObserver = observer;
        });
    };

    proto._installTrendPlotHandlers = function(panelId, plot) {
        if (!plot?.div || plot._trendHandlerDiv === plot.div) return;
        plot._trendHandlerDiv = plot.div;
        let lastShift = false;
        plot.div.addEventListener('mousedown', event => { lastShift = !!event.shiftKey; }, { capture: true });
        plot.div.addEventListener('contextmenu', event => {
            if (this._handleTrendLegendContextMenu(panelId, plot, plot.div, event)) return;
            event.preventDefault();
        });
        plot.div.on('plotly_legendclick', eventData => {
            if (eventData.event?.button !== undefined && eventData.event.button !== 0) {
                lastShift = false;
                return false;
            }
            const clicked = eventData.data?.[eventData.curveNumber];
            // A trend curve's entry selects that segment in the drawer.
            const index = clicked?.meta?.trendIndex;
            if (index !== undefined) {
                this._setTrendActive(panelId, index);
                lastShift = false;
                return false;
            }
            this._handleTrendLegendClick(panelId, plot, clicked?.name, !!(eventData.event?.shiftKey || lastShift));
            lastShift = false;
            return false;
        });
        plot.div.on('plotly_legenddoubleclick', () => false);
        plot.div.on('plotly_afterplot', () => {
            this._installLegendHoverHint?.(plot.div);
            // The band's handles are placed in pixels: a zoom, a pan or a
            // redraw moves the lines they sit on.
            this._refreshTrendBandHandles(plot);
        });
        plot.div.on('plotly_relayout', eventData => this._onRelayout(panelId, eventData));
        plot.div.on('plotly_doubleclick', () => { this._autoScalePlotTimeOnly(plot); return false; });
    };

    // ── Legend ────────────────────────────────────────────────────
    proto._handleTrendLegendClick = function(panelId, plot, name, shiftClick = false) {
        const trace = (plot.traces || []).find(candidate => this._traceName(candidate.varName, candidate.fileId) === name);
        if (!trace) return;
        if (shiftClick) {
            this._removeTrendTraceFromLegend(panelId, plot, trace);
            return;
        }
        trace.visible = trace.visible === 'legendonly' ? true : 'legendonly';
        this._refreshTrendAll(panelId, plot, { preserveView: true });
    };

    proto._handleTrendLegendContextMenu = function(panelId, plot, div, event) {
        const fullTrace = this._legendFullTraceFromContextEvent?.(div, event);
        const name = fullTrace?.name;
        const trace = (plot.traces || []).find(candidate => this._traceName(candidate.varName, candidate.fileId) === name);
        if (!trace) return false;
        event.preventDefault();
        event.stopPropagation();
        this._showLegendTraceMenu(event, trace, {
            onShow: () => this._setTrendLegendSelection(panelId, plot, trace, 'show'),
            onHide: () => this._setTrendLegendSelection(panelId, plot, trace, 'hide'),
            onOnly: () => this._setTrendLegendSelection(panelId, plot, trace, 'only'),
            onRemove: () => this._removeTrendTraceFromLegend(panelId, plot, trace),
        });
        return true;
    };

    proto._setTrendLegendSelection = function(panelId, plot, selectedTrace, action) {
        for (const trace of plot.traces || []) {
            let visible = trace.visible === 'legendonly' || trace.visible === false ? 'legendonly' : true;
            if (action === 'show' && trace === selectedTrace) visible = true;
            if (action === 'hide' && trace === selectedTrace) visible = 'legendonly';
            if (action === 'only') visible = trace === selectedTrace ? true : 'legendonly';
            trace.visible = visible;
        }
        this._refreshTrendAll(panelId, plot, { preserveView: true });
    };

    proto._removeTrendTraceFromLegend = function(panelId, plot, trace) {
        const index = (plot.traces || []).indexOf(trace);
        if (index >= 0) plot.traces.splice(index, 1);
        if (!plot.traces.length) this._clearPanel(panelId);
        else this._rebuildPanel(panelId, { preserveView: true });
    };

    // ── Dragging: the segment's edges, and its band's lines ───────
    // A value on the y axis a trace is drawn against, from a pointer event.
    proto._trendEventToYValue = function(div, event, yref = 'y') {
        const key = yref === 'y2' ? 'yaxis2' : 'yaxis';
        const ya = div?._fullLayout?.[key];
        if (!ya?.range) return NaN;
        const rect = div.getBoundingClientRect();
        const pixel = event.clientY - rect.top - (ya._offset || 0);
        if (typeof ya.p2d === 'function') return this._coerceAxisValue(ya.p2d(pixel));
        if (typeof ya.p2c === 'function') return this._coerceAxisValue(ya.p2c(pixel));
        const frac = pixel / (ya._length || rect.height || 1);
        const r0 = this._coerceAxisValue(ya.range[0]);
        const r1 = this._coerceAxisValue(ya.range[1]);
        return r1 + frac * (r0 - r1);
    };

    // How much of the y axis BAND_GRAB_PX is worth, where the band lines are.
    proto._trendYTolerance = function(div, yref = 'y') {
        const key = yref === 'y2' ? 'yaxis2' : 'yaxis';
        const ya = div?._fullLayout?.[key];
        if (!ya?.range || !ya._length) return 0;
        const r0 = this._coerceAxisValue(ya.range[0]);
        const r1 = this._coerceAxisValue(ya.range[1]);
        return Math.abs(r1 - r0) * (BAND_GRAB_PX / ya._length);
    };

    proto._installTrendSelectionHandlers = function(panelId, plot) {
        if (!plot?.div || plot._trendSelectionDiv === plot.div) return;
        plot._trendSelectionDiv = plot.div;
        let dragging = null;

        // What the pointer is over: a band line of the active segment first
        // (they sit inside its range, where a drag would otherwise move it),
        // then the range's edges, then the range itself.
        const hitTest = (event) => {
            const segment = this._trendActiveSegment(plot);
            if (!segment) return null;
            if (!this._eventInsidePlotArea(plot.div, event)) return null;
            const x = this._eventToXValue(plot.div, event);
            if (!Number.isFinite(x)) return null;
            const domain = this._trendDomain(plot);
            if (!domain) return null;
            const [lo, hi] = this._trendRange(plot, segment);
            const band = trendSegmentBand(segment);
            // A press on a bound's own handle grabs that bound, even where its
            // line is out of view and the pointer is nowhere near its value.
            const onHandle = event.target?.closest?.('.trend-band-handle')?.dataset?.bound;
            if (band && onHandle && Number.isFinite(band[onHandle])) return `band-${onHandle}`;
            if (band && x >= lo && x <= hi) {
                const trace = this._trendTraceFor(plot, segment);
                const yref = this._traceYAxis(trace, plot);
                const y = this._trendEventToYValue(plot.div, event, yref);
                const tolerance = this._trendYTolerance(plot.div, yref);
                if (Number.isFinite(y) && tolerance > 0) {
                    const near = (value) => Number.isFinite(value) && Math.abs(y - value) <= tolerance;
                    if (near(band.upper) && near(band.lower)) {
                        return Math.abs(y - band.upper) <= Math.abs(y - band.lower) ? 'band-upper' : 'band-lower';
                    }
                    if (near(band.upper)) return 'band-upper';
                    if (near(band.lower)) return 'band-lower';
                }
            }
            if (segment.rangeFull) return null;
            const axis = plot.div._fullLayout?.xaxis;
            const span = Math.abs(this._coerceAxisValue(axis?.range?.[1]) - this._coerceAxisValue(axis?.range?.[0])) || Math.abs(hi - lo) || 1;
            const tolerance = Math.max((12 / (axis?._length || 1)) * span, span * 1e-6);
            const nearLeft = Math.abs(x - lo) <= tolerance;
            const nearRight = Math.abs(x - hi) <= tolerance;
            if (nearLeft || nearRight) return nearLeft ? 'left' : 'right';
            const domainSpan = Math.abs(domain.max - domain.min) || 1;
            if (x >= lo && x <= hi && Math.abs(hi - lo) < domainSpan - tolerance) return 'move';
            return null;
        };
        const setCursorHint = (hit) => {
            plot.div?.classList.toggle('fft-cursor-ew', hit === 'left' || hit === 'right');
            plot.div?.classList.toggle('fft-cursor-grab', hit === 'move');
            plot.div?.classList.toggle('trend-cursor-ns', hit === 'band-upper' || hit === 'band-lower');
        };
        plot.div.addEventListener('mousemove', event => { if (!dragging) setCursorHint(hitTest(event)); });
        plot.div.addEventListener('mouseleave', () => { if (!dragging) setCursorHint(null); });
        const onDown = (event) => {
            if (event.button !== 0) return;
            const hit = hitTest(event);
            if (!hit) return;
            const segment = this._trendActiveSegment(plot);
            const [lo, hi] = this._trendRange(plot, segment);
            dragging = {
                hit,
                startX: this._eventToXValue(plot.div, event),
                startLo: lo,
                startHi: hi,
                segment,
                yref: this._traceYAxis(this._trendTraceFor(plot, segment), plot),
            };
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            document.body.classList.add('fft-selection-dragging');
            document.body.classList.toggle('fft-selection-moving', hit === 'move');
        };
        plot.div.addEventListener('mousedown', onDown, true);
        const onMove = (event) => {
            if (!dragging || !plot.div) return;
            if (dragging.hit === 'band-upper' || dragging.hit === 'band-lower') {
                const y = this._trendEventToYValue(plot.div, event, dragging.yref);
                if (!Number.isFinite(y)) return;
                if (dragging.hit === 'band-upper') dragging.segment.upper = y;
                else dragging.segment.lower = y;
                // A bound dragged past the other one swaps them, so the band
                // never turns inside out and throws everything away.
                const lower = finiteOrNull(dragging.segment.lower);
                const upper = finiteOrNull(dragging.segment.upper);
                if (lower !== null && upper !== null && lower > upper) {
                    dragging.segment.lower = upper;
                    dragging.segment.upper = lower;
                    dragging.hit = dragging.hit === 'band-upper' ? 'band-lower' : 'band-upper';
                }
                this._updateTrendSelectionShapes(plot);
                this._syncTrendBandInputs(plot);
                return;
            }
            const domain = this._trendDomain(plot);
            const x = this._eventToXValue(plot.div, event);
            if (!Number.isFinite(x) || !domain) return;
            let lo = dragging.startLo;
            let hi = dragging.startHi;
            if (dragging.hit === 'left') lo = x;
            else if (dragging.hit === 'right') hi = x;
            else {
                let delta = x - dragging.startX;
                if (dragging.startLo + delta < domain.min) delta = domain.min - dragging.startLo;
                if (dragging.startHi + delta > domain.max) delta = domain.max - dragging.startHi;
                lo = dragging.startLo + delta;
                hi = dragging.startHi + delta;
            }
            if (lo > hi) [lo, hi] = [hi, lo];
            dragging.segment.x1 = Math.max(domain.min, Math.min(domain.max, lo));
            dragging.segment.x2 = Math.max(domain.min, Math.min(domain.max, hi));
            this._updateTrendSelectionShapes(plot);
            this._syncTrendRangeInputs(plot);
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = null;
            document.body.classList.remove('fft-selection-dragging', 'fft-selection-moving');
            setCursorHint(null);
            this._scheduleTrendRecompute(panelId);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        plot._trendSelectionDocListeners = { move: onMove, up: onUp };
        this._alsoDragWithTouch(plot.div, plot, '_trendSelectionTouchDiv', { hitTest, onDown, onMove, onUp });
    };

    proto._installTrendSplitterHandlers = function(panelId, plot) {
        const splitter = plot?.trendContainer?.querySelector('.fft-splitter');
        if (!splitter || splitter._trendBound) return;
        splitter._trendBound = true;
        let dragging = false;
        const apply = (event) => {
            const container = plot.trendContainer;
            if (!container) return;
            const state = this._ensureTrendState(plot);
            const rect = container.querySelector('.fft-plot-area')?.getBoundingClientRect();
            if (!rect?.width || !rect?.height) return;
            const fraction = state.layout === 'horizontal'
                ? (event.clientX - rect.left) / rect.width
                : (event.clientY - rect.top) / rect.height;
            state.split = Math.max(0.2, Math.min(0.85, fraction));
            container.style.setProperty('--fft-split', `${Math.round(state.split * 1000) / 10}%`);
            if (plot.div) Plotly.Plots.resize(plot.div);
        };
        splitter.addEventListener('mousedown', event => { dragging = true; event.preventDefault(); document.body.classList.add('fft-split-dragging'); });
        const onMove = event => { if (dragging) apply(event); };
        const onUp = () => { dragging = false; document.body.classList.remove('fft-split-dragging'); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        plot._trendSplitterDocListeners = { move: onMove, up: onUp };
        void panelId;
    };

    proto._cleanupTrendDocListeners = function(plot) {
        for (const key of ['_trendSelectionDocListeners', '_trendSplitterDocListeners']) {
            const listeners = plot?.[key];
            if (!listeners) continue;
            document.removeEventListener('mousemove', listeners.move);
            document.removeEventListener('mouseup', listeners.up);
            plot[key] = null;
        }
        clearTimeout(plot?._trendRecomputeTimer);
        plot?._trendBandHandles?.remove();
        if (plot) plot._trendBandHandles = null;
        this._stopLazyTrends?.(plot);
    };

    // ── Top bar ───────────────────────────────────────────────────
    proto._setTrendLayout = function(panelId, layout) {
        const plot = this.plots.get(panelId);
        if (!plot?.trendContainer || !TREND_LAYOUTS.has(layout)) return;
        this._ensureTrendState(plot).layout = layout;
        plot.trendContainer.classList.toggle('fft-layout-horizontal', layout === 'horizontal');
        plot.trendContainer.classList.toggle('fft-layout-vertical', layout === 'vertical');
        if (plot.div) Plotly.Plots.resize(plot.div);
    };

    proto._toggleTrendTable = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot?.trendContainer) return;
        const state = this._ensureTrendState(plot);
        state.tableHidden = !state.tableHidden;
        plot.trendContainer.classList.toggle('trend-table-hidden', state.tableHidden);
        const button = plot.trendContainer.querySelector('.trend-table-btn');
        if (button) {
            button.textContent = i18n.t(state.tableHidden ? 'trendShowTable' : 'trendHideTable');
            button.classList.toggle('active', state.tableHidden);
            button.setAttribute('aria-pressed', String(state.tableHidden));
        }
        if (plot.div) Plotly.Plots.resize(plot.div);
    };

    proto._toggleTrendOptions = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot?.trendContainer) return;
        const state = this._ensureTrendState(plot);
        state.optionsVisible = !state.optionsVisible;
        syncEdgeToggle(plot.trendContainer, !state.optionsVisible);
        if (plot.trendOptionsEl) plot.trendOptionsEl.hidden = !state.optionsVisible;
        const button = plot.trendContainer.querySelector('.fft-options-btn');
        if (button) {
            button.classList.toggle('active', state.optionsVisible);
            button.setAttribute('aria-pressed', String(state.optionsVisible));
        }
        if (plot.div) Plotly.Plots.resize(plot.div);
    };

    // Reset the view, not the segments: they are work the user did.
    proto._resetTrendView = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot?.div) return;
        this._autoScaleTrendPanel(panelId, plot);
    };

    proto._autoScaleTrendPanel = function(panelId, plot = this.plots.get(panelId)) {
        if (!plot?.div) return Promise.resolve();
        return Promise.resolve(this._autoScalePlotTimeOnly(plot));
    };

    proto._autoScaleTrendAxis = function(plot, axis) {
        if (!plot?.div?._fullLayout) return Promise.resolve();
        return Plotly.relayout(plot.div, axis === 'x' ? { 'xaxis.autorange': true } : { 'yaxis.autorange': true });
    };

    proto._setTrendStatus = function(plot, message, type = 'muted') {
        // While it loads, the shared computing pill with its Cancel button.
        this._noteAnalysisStatus?.(plot, type, { label: message });
        const el = plot?.trendContainer?.querySelector('.fft-status');
        if (!el) return;
        el.textContent = message || '';
        el.className = `fft-status fft-status-${type}`;
        el.title = message || '';
    };

    // ── Editing segments ──────────────────────────────────────────
    proto._setTrendActive = function(panelId, index) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureTrendState(plot);
        state.activeSegment = Math.max(0, Math.min(state.segments.length - 1, Number(index) || 0));
        this._updateTrendSelectionShapes(plot);
        this._renderTrendTable(panelId, plot, plot._trendResults || []);
        this._renderTrendDrawer(panelId, plot, plot._trendResults || []);
    };

    proto._addTrendSegment = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureTrendState(plot);
        if (state.segments.length >= TREND_MAX_SEGMENTS) return;
        const segment = this._newTrendSegment(plot);
        this._seedTrendSelection(plot, segment);
        state.segments.push(segment);
        state.activeSegment = state.segments.length - 1;
        this._updateTrendSelectionShapes(plot);
        this._scheduleTrendRecompute(panelId, { immediate: true });
    };

    proto._removeTrendSegment = function(panelId, index) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureTrendState(plot);
        const removed = state.segments.splice(index, 1)[0];
        if (removed) plot._trendCache?.delete(removed.id);
        if (!state.segments.length) {
            const segment = this._newTrendSegment(plot);
            this._trendTraceFor(plot, segment);
            this._seedTrendSelection(plot, segment);
            state.segments.push(segment);
        }
        state.activeSegment = Math.max(0, Math.min(state.segments.length - 1, index - (index > 0 ? 1 : 0)));
        this._updateTrendSelectionShapes(plot);
        this._scheduleTrendRecompute(panelId, { immediate: true });
    };

    proto._updateTrendSegment = function(panelId, patch) {
        const plot = this.plots.get(panelId);
        const segment = plot ? this._trendActiveSegment(plot) : null;
        if (!segment) return;
        Object.assign(segment, patch);
        this._updateTrendSelectionShapes(plot);
        this._scheduleTrendRecompute(panelId, { immediate: true });
    };

    // The "±kσ" button: the band of the numbers now on screen.
    proto._seedTrendBandFromResult = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureTrendState(plot);
        const segment = this._trendActiveSegment(plot);
        const r = (plot._trendResults || []).find(candidate => candidate.segment === segment);
        const shown = r?.result || r?.staleResult;
        const seeded = seedTrendBand(shown?.trend, state.bandSigma);
        if (!seeded) {
            this._setTrendStatus(plot, i18n.t('trendBandSeedFailed'), 'warning');
            return;
        }
        this._updateTrendSegment(panelId, { bandOn: true, lower: seeded.lower, upper: seeded.upper });
    };

    // ── Help ──────────────────────────────────────────────────────
    proto._showTrendHelp = function() {
        Modal.alert(
            i18n.t('trendHelpTitle'),
            `<div class="help-doc">${i18n.t('trendHelp')}</div>`,
            { html: true, icon: false, className: 'modal-dialog-help phase2d-fit-help-dialog' },
        );
    };

    proto._trendExpModelName = function(model) {
        const option = TREND_EXP_OPTIONS.find(candidate => candidate.id === model);
        return i18n.t(option ? option.key : 'trendExpOff');
    };

    // What a segment with no numbers has to say for itself.
    proto._trendWarningText = function(r) {
        if (r.result) return '';
        if (!r.trace) return i18n.t('trendNoSignals');
        if (r.lazy) {
            if (r.lazyStatus === 'cancelled') return i18n.t(r.staleResult ? 'analysisCancelledKept' : 'analysisCancelled');
            if (r.lazyStatus === 'unsupported') return i18n.t('trendLazyOverviewOnly');
            if (r.lazyStatus === 'generatedAxis') return i18n.t('trendLazyGeneratedAxis');
            if (r.lazyStatus === 'error') return i18n.t('trendLazyError');
            return i18n.t('trendLazyPending');
        }
        return '';
    };

    // ── The table ─────────────────────────────────────────────────
    // One row per segment: what it is, how many rows it used, and the numbers
    // of each trend. The active segment's row is highlighted, and clicking a
    // row selects that segment.
    proto._trendTableColumns = function(plot) {
        const state = this._ensureTrendState(plot);
        const unit = state.timeUnit;
        const perUnit = this._trendUsesCalendar(plot) ? unit : (this._trendSlopeUnit(plot) || '');
        return [
            { key: 'segment', labelKey: 'trendColSegment' },
            { key: 'signal', labelKey: 'trendColSignal' },
            { key: 'start', labelKey: 'trendColStart' },
            { key: 'end', labelKey: 'trendColEnd' },
            { key: 'n', labelKey: 'trendColN', title: 'trendColNTip' },
            { key: 'mean', labelKey: 'trendColMean', numeric: true },
            { key: 'std', labelKey: 'trendColStd', numeric: true, title: 'trendColStdTip' },
            { key: 'slope', label: `${i18n.t('trendColSlope')}${perUnit ? ` [1/${perUnit}]` : ''}`, numeric: true, title: 'trendColSlopeTip' },
            { key: 'delta', labelKey: 'trendColDelta', numeric: true, title: 'trendColDeltaTip' },
            { key: 'r2', labelKey: 'trendColR2', numeric: true, title: 'trendColR2Tip' },
            { key: 'r2quad', labelKey: 'trendColR2Quad', numeric: true, title: 'trendColR2QuadTip' },
            { key: 'tau', label: `τ${perUnit ? ` [${perUnit}]` : ''}`, numeric: true, title: 'trendColTauTip' },
            { key: 'r2exp', labelKey: 'trendColR2Exp', numeric: true, title: 'trendColR2ExpTip' },
        ];
    };

    // The unit of t′ on a numeric axis, for the slope's header.
    proto._trendSlopeUnit = function(plot) {
        const trace = (plot?.traces || []).find(t => this._isVisible(t)) || plot?.traces?.[0];
        return trace ? this._trendTimeInfo(plot, trace).unit : '';
    };

    proto._trendRowValues = function(plot, r) {
        const shown = r.result || r.staleResult || null;
        const trend = shown?.trend || null;
        const linear = trend?.linear;
        const quad = trend?.quadratic;
        const exp = shown?.exp;
        const [lo, hi] = r.trace ? this._trendRange(plot, r.segment) : [NaN, NaN];
        const nText = () => {
            if (!trend) return '—';
            const dropped = [];
            if (trend.nOutliers) dropped.push(`−${i18n.formatNumber(trend.nOutliers)}`);
            if (trend.nMissing) dropped.push(`∅${i18n.formatNumber(trend.nMissing)}`);
            return `${i18n.formatNumber(trend.n)}${dropped.length ? ` (${dropped.join(' ')})` : ''}`;
        };
        return {
            segment: `T${r.index + 1}`,
            signal: r.trace ? this._traceName(r.trace.varName, r.trace.fileId, { units: false }) : '—',
            start: r.trace ? this._trendFormatTime(r.trace, lo) : '—',
            end: r.trace ? this._trendFormatTime(r.trace, hi) : '—',
            n: nText(),
            mean: cell(trend?.mean),
            std: cell(trend?.std),
            slope: linear?.status === 'ok' ? cell(linear.b1) : '—',
            delta: cell(shown?.delta),
            r2: linear?.status === 'ok' ? cell(linear.r2) : '—',
            r2quad: quad?.status === 'ok' ? cell(quad.r2) : '—',
            tau: exp?.status === 'ok' && Number.isFinite(exp.timeConstant) ? cell(exp.timeConstant) : '—',
            r2exp: exp?.status === 'ok' ? cell(exp.r2) : '—',
        };
    };

    proto._renderTrendTable = function(panelId, plot = this.plots.get(panelId), results = plot?._trendResults || []) {
        const host = plot?.trendTableEl;
        if (!host) return;
        const state = this._ensureTrendState(plot);
        host.replaceChildren();
        if (!plot.traces.length) {
            const empty = document.createElement('p');
            empty.className = 'phase2d-fit-empty';
            empty.textContent = i18n.t('trendNoSignals');
            host.appendChild(empty);
            return;
        }
        const head = document.createElement('div');
        head.className = 'trend-table-head';
        const title = document.createElement('h3');
        title.className = 'phase2d-fit-drawer-title';
        title.textContent = i18n.t('trendTableTitle');
        const columns = this._trendTableColumns(plot);
        const rows = results.map(r => this._trendRowValues(plot, r));
        const copyText = () => [
            columns.map(c => c.label || i18n.t(c.labelKey)).join('\t'),
            ...rows.map(row => columns.map(c => row[c.key]).join('\t')),
        ].join('\n');
        const copyBtn = createCopyButton(copyText, { className: 'curve-fit-copy-btn' });
        copyBtn.disabled = !rows.length;
        const helpBtn = document.createElement('button');
        helpBtn.type = 'button';
        helpBtn.className = 'fft-help-btn';
        helpBtn.textContent = '?';
        helpBtn.title = i18n.t('trendHelpTitle');
        helpBtn.setAttribute('aria-label', i18n.t('trendHelpTitle'));
        helpBtn.addEventListener('click', () => this._showTrendHelp());
        head.append(title, helpBtn, copyBtn);
        host.appendChild(head);

        const table = document.createElement('table');
        table.className = 'trend-table';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const column of columns) {
            const th = document.createElement('th');
            th.textContent = column.label || i18n.t(column.labelKey);
            if (column.title) th.title = i18n.t(column.title);
            if (column.numeric) th.className = 'trend-num';
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        const tbody = document.createElement('tbody');
        results.forEach((r, index) => {
            const row = rows[index];
            const tr = document.createElement('tr');
            tr.className = `trend-row${index === state.activeSegment ? ' trend-row-active' : ''}`;
            tr.tabIndex = 0;
            tr.setAttribute('role', 'button');
            tr.title = i18n.t('trendRowSelect');
            const select = () => this._setTrendActive(panelId, index);
            tr.addEventListener('click', select);
            tr.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); }
            });
            for (const column of columns) {
                const td = document.createElement('td');
                if (column.numeric) td.className = 'trend-num';
                if (column.key === 'segment') {
                    const swatch = document.createElement('span');
                    swatch.className = 'phase2d-fit-swatch trend-swatch';
                    swatch.style.background = r.color;
                    const text = document.createElement('span');
                    text.textContent = row.segment;
                    td.append(swatch, text);
                } else {
                    td.textContent = row[column.key];
                }
                td.title = td.textContent;
                tr.appendChild(td);
            }
            // A segment with nothing to show says why, under its row.
            const warning = this._trendWarningText(r);
            if (warning) tr.title = warning;
            tbody.appendChild(tr);
        });
        table.append(thead, tbody);
        host.appendChild(table);

        const notes = results
            .map(r => ({ index: r.index, text: this._trendWarningText(r) }))
            .filter(note => note.text);
        if (notes.length) {
            const list = document.createElement('div');
            list.className = 'trend-table-notes';
            for (const note of notes) {
                const line = document.createElement('div');
                line.className = 'trend-table-note';
                line.textContent = `T${note.index + 1}: ${note.text}`;
                list.appendChild(line);
            }
            host.appendChild(list);
        }
    };

    // ── Drawer ────────────────────────────────────────────────────
    // 1) which segment, add/remove; 2) its signal; 3) its range;
    // 4) its value band; 5) its exponential; 6) which curves are drawn;
    // 7) the unit of t′; 8) the numbers of the active segment in full.
    proto._renderTrendDrawer = function(panelId, plot = this.plots.get(panelId), results = plot?._trendResults || []) {
        const drawer = plot?.trendOptionsEl;
        if (!drawer) return;
        const state = this._ensureTrendState(plot);
        // The drawer is drawn again on every paint — a lazy segment settling,
        // a key moving a bound — and the field being worked in must survive
        // that: which one it was, and where the caret sat in it.
        const active = document.activeElement;
        const held = drawer.contains(active) && active?.dataset
            ? {
                selector: active.dataset.trendBandKey
                    ? `.fft-number-input[data-trend-band-key="${active.dataset.trendBandKey}"]`
                    : (active.dataset.trendKey ? `.fft-number-input[data-trend-key="${active.dataset.trendKey}"]` : null),
                start: active.selectionStart,
                end: active.selectionEnd,
            }
            : null;
        drawer.replaceChildren();
        if (!plot.traces.length) {
            const empty = document.createElement('p');
            empty.className = 'phase2d-fit-empty';
            empty.textContent = i18n.t('trendNoSignals');
            drawer.appendChild(empty);
            return;
        }
        const segment = this._trendActiveSegment(plot);
        const trace = this._trendTraceFor(plot, segment);
        const field = (labelKey, control, extra = null) => {
            const wrap = document.createElement('div');
            wrap.className = 'phase2d-fit-field';
            const label = document.createElement('span');
            label.className = 'phase2d-fit-field-label';
            label.textContent = i18n.t(labelKey);
            wrap.append(label, control);
            if (extra) wrap.appendChild(extra);
            return wrap;
        };
        const makeRow = (labelText, control, tooltip = '') => {
            const label = document.createElement('label');
            label.className = 'fft-option-row';
            if (tooltip) label.title = tooltip;
            const span = document.createElement('span');
            span.textContent = labelText;
            label.append(span, control);
            return label;
        };
        const helpButton = (titleKey, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'fft-help-btn';
            button.textContent = '?';
            button.title = i18n.t(titleKey);
            button.setAttribute('aria-label', i18n.t(titleKey));
            button.addEventListener('click', onClick);
            return button;
        };

        // 1) Segment list
        const segmentSelect = document.createElement('select');
        segmentSelect.className = 'phase2d-fit-pair-select curve-fit-select trend-segment-select';
        segmentSelect.setAttribute('aria-label', i18n.t('trendSegment'));
        state.segments.forEach((candidate, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            const segTrace = (plot.traces || []).find(t => t.varName === candidate.varName && t.fileId === candidate.fileId);
            const signal = segTrace ? this._traceName(segTrace.varName, segTrace.fileId, { units: false }) : '—';
            option.textContent = `T${index + 1} · ${signal}`;
            option.title = option.textContent;
            option.selected = index === state.activeSegment;
            segmentSelect.appendChild(option);
        });
        segmentSelect.addEventListener('change', () => this._setTrendActive(panelId, Number(segmentSelect.value)));
        const segmentButtons = document.createElement('div');
        segmentButtons.className = 'curve-fit-list-actions';
        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'fft-tool-btn trend-add-btn';
        addButton.textContent = i18n.t('trendAdd');
        addButton.title = i18n.t('trendAddTip');
        addButton.disabled = state.segments.length >= TREND_MAX_SEGMENTS;
        addButton.addEventListener('click', () => this._addTrendSegment(panelId));
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'fft-tool-btn trend-remove-btn';
        removeButton.textContent = i18n.t('trendRemove');
        removeButton.title = i18n.t('trendRemoveTip');
        removeButton.addEventListener('click', () => this._removeTrendSegment(panelId, state.activeSegment));
        segmentButtons.append(addButton, removeButton);
        const swatch = document.createElement('span');
        swatch.className = 'phase2d-fit-swatch curve-fit-swatch';
        swatch.style.background = trendColor(state.activeSegment);
        const segmentField = field('trendSegment', segmentSelect, segmentButtons);
        segmentField.querySelector('.phase2d-fit-field-label').prepend(swatch);
        drawer.appendChild(segmentField);

        // 2) Signal
        const signalSelect = document.createElement('select');
        signalSelect.className = 'phase2d-fit-pair-select trend-signal-select';
        signalSelect.setAttribute('aria-label', i18n.t('trendSignal'));
        plot.traces.forEach((candidate, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = this._traceName(candidate.varName, candidate.fileId);
            option.title = option.textContent;
            option.selected = candidate === trace;
            signalSelect.appendChild(option);
        });
        signalSelect.addEventListener('change', () => {
            const picked = plot.traces[Number(signalSelect.value)];
            if (picked) this._updateTrendSegment(panelId, { varName: picked.varName, fileId: picked.fileId });
        });
        const signalField = field('trendSignal', signalSelect, helpButton('trendHelpTitle', () => this._showTrendHelp()));
        drawer.appendChild(signalField);

        // 3) Range
        const usesCalendar = !!trace && this._canonicalFftKind(trace.fileId) === 'datetime';
        const segmented = document.createElement('div');
        segmented.className = 'fft-segmented';
        const makeSegment = (labelKey, tooltipKey, isFull) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = i18n.t(labelKey);
            button.title = i18n.t(tooltipKey);
            button.classList.toggle('active', !!segment.rangeFull === isFull);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                if (!!segment.rangeFull === isFull) return;
                const patch = { rangeFull: isFull };
                if (!isFull && (segment.x1 === null || segment.x2 === null)) {
                    const probe = { ...segment };
                    this._seedTrendSelection(plot, probe);
                    patch.x1 = probe.x1;
                    patch.x2 = probe.x2;
                }
                this._updateTrendSegment(panelId, patch);
            });
            return button;
        };
        segmented.append(
            makeSegment('fftRangeFull', 'trendRangeFullTooltip', true),
            makeSegment('fftRangeSelection', 'trendRangeSelectionTooltip', false),
        );
        drawer.appendChild(makeRow(i18n.t('fftRange'), segmented));
        const [lo, hi] = this._trendRange(plot, segment);
        const makeTimeInput = (key, value) => {
            const input = document.createElement('input');
            input.type = usesCalendar ? 'datetime-local' : 'number';
            input.step = usesCalendar ? '1' : 'any';
            input.className = 'fft-number-input';
            input.dataset.trendKey = key;
            input.value = usesCalendar ? msToDatetimeInput(value) : formatInputValue(value);
            input.disabled = !!segment.rangeFull;
            input.addEventListener('change', () => {
                const n = usesCalendar ? datetimeInputToMs(input.value) : Number(input.value);
                if (!Number.isFinite(n)) return;
                const [curLo, curHi] = this._trendRange(plot, segment);
                this._updateTrendSegment(panelId, key === 'x1' ? { x1: n, x2: curHi } : { x1: curLo, x2: n });
            });
            return input;
        };
        const rangeGrid = document.createElement('div');
        rangeGrid.className = 'fft-range-grid';
        const bound = (labelKey, key, value) => {
            const wrap = document.createElement('div');
            wrap.className = 'fft-range-bound';
            if (usesCalendar) wrap.classList.add('fft-range-bound-datetime');
            wrap.appendChild(makeRow(i18n.t(labelKey), makeTimeInput(key, value)));
            return wrap;
        };
        rangeGrid.append(bound('fftRangeStart', 'x1', lo), bound('fftRangeEnd', 'x2', hi));
        drawer.appendChild(rangeGrid);

        // 4) The value band
        const bandBlock = document.createElement('div');
        bandBlock.className = 'trend-band-block';
        const bandLabel = document.createElement('label');
        bandLabel.className = 'curve-fit-extrapolate trend-band-toggle';
        bandLabel.title = i18n.t('trendBandTip');
        const bandBox = document.createElement('input');
        bandBox.type = 'checkbox';
        bandBox.className = 'trend-band-box';
        bandBox.checked = !!segment.bandOn;
        bandBox.addEventListener('change', () => {
            const patch = { bandOn: bandBox.checked };
            // Turned on with no bounds yet: start from the numbers on screen.
            if (bandBox.checked && segment.lower === null && segment.upper === null) {
                const r = (plot._trendResults || []).find(candidate => candidate.segment === segment);
                const seeded = seedTrendBand((r?.result || r?.staleResult)?.trend, state.bandSigma);
                if (seeded) {
                    patch.lower = seeded.lower;
                    patch.upper = seeded.upper;
                }
            }
            this._updateTrendSegment(panelId, patch);
        });
        const bandText = document.createElement('span');
        bandText.textContent = i18n.t('trendBand');
        bandLabel.append(bandBox, bandText);
        bandBlock.appendChild(bandLabel);
        const makeBandInput = (key, value) => {
            const input = document.createElement('input');
            input.type = 'number';
            input.step = 'any';
            input.className = 'fft-number-input';
            input.dataset.trendBandKey = key;
            input.value = value === null ? '' : formatInputValue(value);
            input.disabled = !segment.bandOn;
            input.placeholder = i18n.t('trendBandOpen');
            input.title = i18n.t('trendBandKeysTip');
            input.addEventListener('change', () => {
                this._updateTrendSegment(panelId, { [key]: finiteOrNull(input.value) });
            });
            // The arrows move the bound by a step of the value axis, Shift and
            // the Page keys by ten — the same move as the handle on its line,
            // instead of the browser's step of one, which means nothing to a
            // signal in millivolts or megawatts.
            input.addEventListener('keydown', (event) => this._moveTrendBandByKey(panelId, key, event, { ends: false, focusHandle: false }));
            return input;
        };
        const bandGrid = document.createElement('div');
        bandGrid.className = 'fft-range-grid trend-band-grid';
        for (const [labelKey, key] of [['trendBandLower', 'lower'], ['trendBandUpper', 'upper']]) {
            const wrap = document.createElement('div');
            wrap.className = 'fft-range-bound';
            wrap.appendChild(makeRow(i18n.t(labelKey), makeBandInput(key, finiteOrNull(segment[key]))));
            bandGrid.appendChild(wrap);
        }
        bandBlock.appendChild(bandGrid);
        const sigmaRow = document.createElement('div');
        sigmaRow.className = 'trend-band-sigma';
        const sigmaInput = document.createElement('input');
        sigmaInput.type = 'number';
        sigmaInput.step = '0.5';
        sigmaInput.min = '0.1';
        sigmaInput.className = 'fft-number-input trend-sigma-input';
        sigmaInput.value = String(state.bandSigma);
        sigmaInput.addEventListener('change', () => {
            const n = Number(sigmaInput.value);
            if (Number.isFinite(n) && n > 0) state.bandSigma = n;
            sigmaInput.value = String(state.bandSigma);
        });
        const sigmaBtn = document.createElement('button');
        sigmaBtn.type = 'button';
        sigmaBtn.className = 'fft-tool-btn trend-sigma-btn';
        sigmaBtn.textContent = i18n.t('trendBandSeed');
        sigmaBtn.title = i18n.t('trendBandSeedTip');
        sigmaBtn.addEventListener('click', () => this._seedTrendBandFromResult(panelId));
        sigmaRow.append(sigmaInput, sigmaBtn);
        bandBlock.appendChild(sigmaRow);
        drawer.appendChild(bandBlock);

        // 5) The exponential of this segment
        const expSelect = document.createElement('select');
        expSelect.className = 'phase2d-fit-type-select trend-exp-select';
        expSelect.setAttribute('aria-label', i18n.t('trendExp'));
        for (const option of TREND_EXP_OPTIONS) {
            const el = document.createElement('option');
            el.value = option.id;
            el.textContent = i18n.t(option.key);
            el.selected = option.id === (segment.expModel || 'none');
            expSelect.appendChild(el);
        }
        expSelect.addEventListener('change', () => this._updateTrendSegment(panelId, { expModel: expSelect.value }));
        const expField = field('trendExp', expSelect);
        expField.title = i18n.t('trendExpTip');
        drawer.appendChild(expField);

        // 6) Which curves are drawn
        const curvesBlock = document.createElement('div');
        curvesBlock.className = 'trend-curves-block';
        const curvesTitle = document.createElement('div');
        curvesTitle.className = 'phase2d-fit-field-label';
        curvesTitle.textContent = i18n.t('trendCurvesTitle');
        curvesBlock.appendChild(curvesTitle);
        for (const kind of TREND_CURVES) {
            const label = document.createElement('label');
            label.className = 'curve-fit-extrapolate trend-curve-toggle';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = state.curves[kind] !== false;
            box.dataset.trendCurve = kind;
            box.addEventListener('change', () => {
                state.curves[kind] = box.checked;
                this._replaceTrendTraces(plot, plot._trendResults || []);
            });
            const text = document.createElement('span');
            text.textContent = i18n.t(CURVE_LABEL_KEY[kind]);
            label.append(box, text);
            curvesBlock.appendChild(label);
        }
        drawer.appendChild(curvesBlock);

        // 7) Unit of t′
        if (usesCalendar) {
            const unitSelect = document.createElement('select');
            unitSelect.className = 'phase2d-fit-type-select curve-fit-unit-select';
            unitSelect.title = i18n.t('trendTimeUnitTip');
            for (const unit of Object.keys(CURVE_FIT_TIME_UNITS)) {
                const option = document.createElement('option');
                option.value = unit;
                option.textContent = unit;
                option.selected = unit === state.timeUnit;
                unitSelect.appendChild(option);
            }
            unitSelect.addEventListener('change', () => {
                state.timeUnit = unitSelect.value;
                this._scheduleTrendRecompute(panelId, { immediate: true });
            });
            drawer.appendChild(field('trendTimeUnit', unitSelect));
        }

        // 8) The active segment in full
        const r = results.find(candidate => candidate.segment === segment) || { segment, index: state.activeSegment };
        drawer.appendChild(this._renderTrendResultBlock(plot, r, trace));

        const refocus = held?.selector ? drawer.querySelector(held.selector) : null;
        if (refocus) {
            refocus.focus({ preventScroll: true });
            // A number field has no selection to restore in every browser.
            try { refocus.setSelectionRange(held.start, held.end); } catch (_) { /* no selection here */ }
        }
    };

    // The numbers of one segment, written out: the mean with its spread, each
    // trend's equation in t′ and its metrics, and what the band took out.
    proto._renderTrendResultBlock = function(plot, r, trace) {
        const block = document.createElement('div');
        block.className = 'phase2d-fit-result trend-result';
        const shown = r.result || r.staleResult || null;
        const trend = shown?.trend;
        const warning = this._trendWarningText(r);
        if (!trend) {
            const hint = document.createElement('p');
            hint.className = 'phase2d-fit-empty';
            hint.textContent = warning || i18n.t('trendCalculating');
            block.appendChild(hint);
            return block;
        }
        const head = document.createElement('div');
        head.className = 'phase2d-fit-results-head';
        const title = document.createElement('h3');
        title.className = 'phase2d-fit-drawer-title';
        title.textContent = i18n.t('trendResultsTitle');
        const copyLines = [];
        const copyBtn = createCopyButton(() => copyLines.join('\n'), { className: 'curve-fit-copy-btn' });
        head.append(title, copyBtn);
        block.appendChild(head);

        const unit = shown.unit || '';
        const origin = document.createElement('div');
        origin.className = 'curve-fit-origin';
        origin.textContent = `t′ = t − t₀${unit ? ` [${unit}]` : ''} · t₀ = ${this._trendFormatTime(trace, shown.t0)}`;
        origin.title = i18n.t('trendTimeOrigin');
        block.appendChild(origin);
        copyLines.push(
            ...(trace ? [this._traceName(trace.varName, trace.fileId, { units: false })] : []),
            origin.textContent,
        );

        const stats = document.createElement('dl');
        stats.className = 'phase2d-fit-stats trend-stats';
        const rows = [
            [i18n.t('trendStatMean'), cell(trend.mean)],
            [i18n.t('trendStatStd'), cell(trend.std)],
            [i18n.t('trendStatMeanRmse'), cell(trend.meanRmse)],
            [i18n.t('trendStatMin'), cell(trend.minY)],
            [i18n.t('trendStatMax'), cell(trend.maxY)],
            [i18n.t('trendStatRows'), i18n.formatNumber(trend.n)],
            [i18n.t('trendStatOutliers'), i18n.formatNumber(trend.nOutliers)],
            [i18n.t('trendStatMissing'), i18n.formatNumber(trend.nMissing)],
        ];
        for (const [k, v] of rows) {
            const dt = document.createElement('dt'); dt.textContent = k;
            const dd = document.createElement('dd'); dd.textContent = v;
            stats.append(dt, dd);
            copyLines.push(`${k}: ${v}`);
        }
        block.appendChild(stats);

        // Each trend's equation and metrics, one block per model.
        const fits = [
            ['linear', trend.linear],
            ['quadratic', trend.quadratic],
            ['exp', shown.exp],
        ];
        for (const [kind, fit] of fits) {
            if (!fit) continue;
            const wrap = document.createElement('div');
            wrap.className = 'trend-fit-block';
            const name = document.createElement('div');
            name.className = 'phase2d-fit-field-label';
            name.textContent = kind === 'exp'
                ? `${i18n.t(CURVE_LABEL_KEY.exp)} · ${this._trendExpModelName(r.segment.expModel)}`
                : i18n.t(CURVE_LABEL_KEY[kind]);
            wrap.appendChild(name);
            copyLines.push('', name.textContent);
            if (fit.status !== 'ok') {
                const bad = document.createElement('div');
                bad.className = 'phase2d-fit-warning';
                bad.textContent = this._trendFitWarning(fit);
                wrap.appendChild(bad);
                copyLines.push(bad.textContent);
                block.appendChild(wrap);
                continue;
            }
            const parts = fitEquationParts(fit, 't′');
            if (parts) {
                const eq = document.createElement('div');
                eq.className = 'phase2d-fit-equation';
                eq.textContent = parts.generic;
                wrap.appendChild(eq);
                copyLines.push(parts.generic);
                const coeffs = document.createElement('div');
                coeffs.className = 'phase2d-fit-coeffs';
                for (const [k, v] of parts.coeffs) {
                    const row = document.createElement('div');
                    row.className = 'phase2d-fit-coeff';
                    const kEl = document.createElement('span');
                    kEl.className = 'phase2d-fit-coeff-k';
                    kEl.textContent = k;
                    const vEl = document.createElement('span');
                    vEl.className = 'phase2d-fit-coeff-v';
                    vEl.textContent = `= ${v}`;
                    row.append(kEl, vEl);
                    coeffs.appendChild(row);
                    copyLines.push(`${k} = ${v}`);
                }
                wrap.appendChild(coeffs);
            }
            const metrics = document.createElement('dl');
            metrics.className = 'phase2d-fit-stats';
            const metricRows = [
                [i18n.t('phase2dFitRSquared'), cell(fit.r2)],
                [i18n.t('phase2dFitRmse'), cell(fit.rmse)],
            ];
            if (kind === 'linear' && Number.isFinite(shown.delta)) {
                metricRows.unshift([i18n.t('trendColDelta'), cell(shown.delta)]);
            }
            for (const [k, v] of metricRows) {
                const dt = document.createElement('dt'); dt.textContent = k;
                const dd = document.createElement('dd'); dd.textContent = v;
                metrics.append(dt, dd);
                copyLines.push(`${k}: ${v}`);
            }
            wrap.appendChild(metrics);
            block.appendChild(wrap);
        }
        copyBtn.disabled = !copyLines.length;
        if (warning) {
            const w = document.createElement('div');
            w.className = 'phase2d-fit-warning';
            w.setAttribute('role', 'status');
            w.textContent = warning;
            block.appendChild(w);
        }
        return block;
    };

    proto._trendFitWarning = function(fit) {
        const map = {
            'insufficient-n': i18n.t('phase2dFitInsufficientN'),
            'x-constant': i18n.t('phase2dFitNoData'),
            'y-constant': i18n.t('phase2dFitYConstant'),
            singular: i18n.t('phase2dFitSingular'),
            'coefficient-overflow': i18n.t('fitCoefficientOverflow'),
        };
        if (!fit) return i18n.t('phase2dFitNoData');
        return map[fit.warning] || fit.warning || i18n.t('phase2dFitNoData');
    };

    // Refresh the drawer's fields from the active segment while it is being
    // dragged. These are called from a drag and from nowhere else: the pointer
    // is on the plot, so there is no one typing in the field to fight with,
    // and a field left saying what the line said before the drag would be a
    // field that lies.
    proto._syncTrendRangeInputs = function(plot) {
        const drawer = plot?.trendOptionsEl;
        const segment = this._trendActiveSegment(plot);
        if (!drawer || !segment) return;
        const trace = this._trendTraceFor(plot, segment);
        const usesCalendar = !!trace && this._canonicalFftKind(trace.fileId) === 'datetime';
        const [lo, hi] = this._trendRange(plot, segment);
        for (const [key, value] of [['x1', lo], ['x2', hi]]) {
            const input = drawer.querySelector(`.fft-number-input[data-trend-key="${key}"]`);
            if (input) input.value = usesCalendar ? msToDatetimeInput(value) : formatInputValue(value);
        }
    };

    proto._syncTrendBandInputs = function(plot) {
        const drawer = plot?.trendOptionsEl;
        const segment = this._trendActiveSegment(plot);
        if (!drawer || !segment) return;
        for (const key of ['lower', 'upper']) {
            const input = drawer.querySelector(`.fft-number-input[data-trend-band-key="${key}"]`);
            if (!input) continue;
            const value = finiteOrNull(segment[key]);
            input.value = value === null ? '' : formatInputValue(value);
        }
    };

    // Everything the drawer shows, after Cancel put the settings back.
    proto._syncTrendOptionsPanel = function(plot) {
        const panelId = this._panelIdForPlot?.(plot);
        this._renderTrendDrawer(panelId, plot, plot?._trendResults || []);
        this._renderTrendTable(panelId, plot, plot?._trendResults || []);
    };

    // ── CSV export ────────────────────────────────────────────────
    proto._exportTrendCsv = async function(panelId, plot = this.plots.get(panelId), options = {}) {
        if (!plot || plot.mode !== 'trend') return;
        const out = this._trendSummaryCsv(plot);
        if (!out) return;
        const filename = options.baseName ? `${options.baseName}_trend.csv` : out.filename;
        this._downloadCsvColumns(out.headers, out.columns, filename);
    };

    proto._trendTimeCell = function(trace, value) {
        if (!Number.isFinite(value)) return '';
        if (trace && this._canonicalFftKind(trace.fileId) === 'datetime') return new Date(value).toISOString();
        return value;
    };

    proto._trendSummaryCsv = function(plot) {
        const results = this._computeTrends(plot);
        if (!results.length) return null;
        const num = (v) => (Number.isFinite(v) ? v : '');
        const shownOf = (r) => r.result || r.staleResult || null;
        const trendOf = (r) => shownOf(r)?.trend || null;
        const fields = [
            ['segment', (r) => `T${r.index + 1}`],
            ['file', (r) => (r.trace ? (this.files.get(r.trace.fileId)?.name ?? r.trace.fileId ?? '') : '')],
            ['signal', (r) => (r.trace ? this._variableLabel(r.trace.varName, r.trace.fileId) : '')],
            ['signal_unit', (r) => (r.trace ? this._phase2dVarUnit?.(r.trace.fileId, r.trace.varName) ?? '' : '')],
            ['range', (r) => (r.segment.rangeFull ? 'all' : 'selection')],
            ['range_start', (r) => (r.trace ? this._trendTimeCell(r.trace, this._trendRange(plot, r.segment)[0]) : '')],
            ['range_end', (r) => (r.trace ? this._trendTimeCell(r.trace, this._trendRange(plot, r.segment)[1]) : '')],
            ['t0', (r) => (r.trace ? this._trendTimeCell(r.trace, shownOf(r)?.t0) : '')],
            ['t_prime_unit', (r) => shownOf(r)?.unit ?? ''],
            ['band_lower', (r) => num(shownOf(r)?.band?.lower)],
            ['band_upper', (r) => num(shownOf(r)?.band?.upper)],
            ['n_scope', (r) => num(trendOf(r)?.nScope)],
            ['n_used', (r) => num(trendOf(r)?.n)],
            ['n_outliers', (r) => num(trendOf(r)?.nOutliers)],
            ['n_missing', (r) => num(trendOf(r)?.nMissing)],
            ['mean', (r) => num(trendOf(r)?.mean)],
            ['std', (r) => num(trendOf(r)?.std)],
            ['mean_rmse', (r) => num(trendOf(r)?.meanRmse)],
            ['min', (r) => num(trendOf(r)?.minY)],
            ['max', (r) => num(trendOf(r)?.maxY)],
            ['linear_slope', (r) => num(trendOf(r)?.linear?.b1)],
            ['linear_intercept', (r) => num(trendOf(r)?.linear?.b0)],
            ['linear_delta', (r) => num(shownOf(r)?.delta)],
            ['linear_r', (r) => num(trendOf(r)?.linear?.r)],
            ['linear_r2', (r) => num(trendOf(r)?.linear?.r2)],
            ['linear_rmse', (r) => num(trendOf(r)?.linear?.rmse)],
            ['quadratic_a', (r) => num(trendOf(r)?.quadratic?.a)],
            ['quadratic_b', (r) => num(trendOf(r)?.quadratic?.b)],
            ['quadratic_c', (r) => num(trendOf(r)?.quadratic?.c)],
            ['quadratic_r2', (r) => num(trendOf(r)?.quadratic?.r2)],
            ['quadratic_rmse', (r) => num(trendOf(r)?.quadratic?.rmse)],
            ['exp_model', (r) => (r.segment.expModel === 'none' ? '' : r.segment.expModel)],
            ['exp_a', (r) => num(shownOf(r)?.exp?.a)],
            ['exp_b', (r) => num(shownOf(r)?.exp?.b)],
            ['exp_c', (r) => num(shownOf(r)?.exp?.c)],
            ['exp_K', (r) => num(shownOf(r)?.exp?.K)],
            ['exp_alpha', (r) => num(shownOf(r)?.exp?.alpha)],
            ['exp_y0', (r) => num(shownOf(r)?.exp?.y0)],
            ['exp_time_constant', (r) => num(shownOf(r)?.exp?.timeConstant)],
            ['exp_r2', (r) => num(shownOf(r)?.exp?.r2)],
            ['exp_rmse', (r) => num(shownOf(r)?.exp?.rmse)],
            ['status', (r) => (r.result ? 'ok' : (r.lazy ? r.lazyStatus || 'pending' : 'none'))],
        ];
        const headers = [];
        const columns = [];
        for (const [header, fn] of fields) {
            headers.push(header);
            columns.push(results.map(r => csvValueCell(fn(r))));
        }
        return { headers, columns, filename: 'trend_segments.csv' };
    };
}
