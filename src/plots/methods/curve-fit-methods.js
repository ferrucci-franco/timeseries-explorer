import i18n from '../../i18n/index.js';
import { createEdgeToggle, syncEdgeToggle } from '../../ui/edge-toggle.js';
import Plotly from '../../vendor/plotly.js';
import Modal from '../../ui/modal.js';
import { createCopyButton } from '../../ui/copy-button.js';
import { buildFitCurve } from '../../utils/regression.js';
import { FIT_MAX_LAZY_ROWS } from './fit-lazy-methods.js';
import {
    FIT_MODEL_OPTIONS,
    FIT_MODEL_SHORT_KEYS,
    FIT_CSV_COEFFICIENTS,
    fitCsvCoefficient,
    fitEquationParts,
    formatFitCoefficient,
} from '../../utils/fit-models.js';
import {
    CURVE_FIT_LAYOUTS,
    CURVE_FIT_MAX_FITS,
    CURVE_FIT_TIME_UNITS,
    defaultCurveFitEntry,
    defaultCurveFitState,
    normalizeCurveFitState,
    curveFitFormula,
    rangeIndices,
} from '../curve-fit-state.js';
import { csvValueCell } from '../../utils/csv-cell.js';

// The Curve Fit analysis of a time series: fit a model to each chosen stretch
// of a signal, with time measured from the start of that stretch.
//
// It is the time-series counterpart of the 2D plot's Curve Fit and shares its
// models, its equations and its look (utils/fit-models.js, the phase2d-fit-*
// classes). What differs is the independent variable: here it is time, and a
// fit of a transient is only readable in the time since the transient began.
// Each fit's equation is therefore written in t′ = t − t₀, where t₀ is the
// start of that fit's own range — a first-order response fitted from 17:08
// reads y = y₀ + K·(1 − e^(α·t′)) with t′ in seconds since 17:08, not an
// exponential of the epoch.
//
// A panel holds several fits (plots/curve-fit-state.js), each on its own
// signal, model and range: a line over the ramp, an exponential over the tail.
// The active fit's range is the green band on the time pane, dragged exactly
// like the range of every other analysis; the other fits' ranges stay drawn,
// grey, so the segments can be placed against each other.
//
// The pane under the time series shows the residuals y − ŷ of every fit. A
// good fit leaves noise there; a wrong model leaves a shape.

const RECOMPUTE_DEBOUNCE_MS = 150;
const FIT_COLORS = ['#e53935', '#8e24aa', '#f57c00', '#00897b', '#3949ab', '#6d4c41', '#c2185b', '#7cb342'];

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

export function curveFitColor(index) {
    return FIT_COLORS[index % FIT_COLORS.length];
}

export function installPlotCurveFitMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // ── State ──────────────────────────────────────────────────────
    proto._defaultCurveFitState = function() {
        return defaultCurveFitState();
    };

    proto._normalizeCurveFitState = function(raw = {}) {
        return normalizeCurveFitState(raw || {});
    };

    proto._ensureCurveFitState = function(plot) {
        if (!plot) return defaultCurveFitState();
        const current = plot.curveFit;
        const normalized = normalizeCurveFitState(current || {});
        if (current && typeof current === 'object' && !Array.isArray(current)) {
            // Handlers and results hold this object and its fits; keep the
            // identity of both, normalising each fit in place.
            const previous = Array.isArray(current.fits) ? current.fits : [];
            normalized.fits = normalized.fits.map((fit, index) => {
                const old = previous[index];
                if (old && typeof old === 'object' && old.id === fit.id) return Object.assign(old, fit);
                return fit;
            });
            Object.assign(current, normalized);
            return current;
        }
        plot.curveFit = normalized;
        return normalized;
    };

    proto._curveFitActiveEntry = function(plot) {
        const state = this._ensureCurveFitState(plot);
        return state.fits[state.activeFit] || state.fits[0] || null;
    };

    // The panel trace a fit reads. A fit whose signal left the panel falls back
    // to the first visible one, so it never silently fits nothing.
    proto._curveFitTraceFor = function(plot, entry) {
        const traces = plot?.traces || [];
        const own = traces.find(t => t.varName === entry?.varName && t.fileId === entry?.fileId);
        if (own) return own;
        const fallback = traces.find(t => this._isVisible(t)) || traces[0] || null;
        if (fallback && entry) {
            entry.varName = fallback.varName;
            entry.fileId = fallback.fileId;
        }
        return fallback;
    };

    proto._curveFitOptionsPanel = function(plot) {
        return plot?.curveFitOptionsEl || null;
    };

    // ── Adding signals ─────────────────────────────────────────────
    proto._addCurveFitTrace = function(panelId, varName, panelEl, plot) {
        if (plot.traces.find(trace => trace.varName === varName && trace.fileId === this.activeFileId)) return;
        if (!this._canAddTraceWithFileTime(plot, this.activeFileId)) return;
        plot.traces.push({
            varName,
            color: this._nextTraceColor(plot.traces),
            fileId: this.activeFileId,
            axis: 'y',
        });
        // The signal just dropped is the one the user means to fit next.
        const entry = this._curveFitActiveEntry(plot);
        if (entry && entry.model === 'none') {
            entry.varName = varName;
            entry.fileId = this.activeFileId;
        }
        if (!plot.div) this._createCurveFitChart(panelId, panelEl);
        else this._refreshCurveFitAll(panelId, plot, { preserveView: true });
    };

    // ── Time axis ─────────────────────────────────────────────────
    // What t′ is measured in for a trace: on a calendar axis a chosen unit of
    // the millisecond times, elsewhere the axis's own unit.
    proto._curveFitTimeInfo = function(plot, trace) {
        const state = this._ensureCurveFitState(plot);
        const calendar = !!trace && this._fftTimeKind(trace.fileId) === 'datetime';
        if (calendar) {
            return { calendar, scale: CURVE_FIT_TIME_UNITS[state.timeUnit] || 1000, unit: state.timeUnit };
        }
        const unit = trace ? String(this._timeUnitLabel(trace.fileId) || '').trim() : '';
        const shown = unit === 'duration' || unit === 'datetime' ? 's' : (unit === 'index' ? '' : unit);
        return { calendar, scale: 1, unit: shown };
    };

    proto._curveFitUsesCalendar = function(plot) {
        const trace = (plot?.traces || []).find(t => this._isVisible(t)) || plot?.traces?.[0];
        return trace ? this._fftTimeKind(trace.fileId) === 'datetime' : false;
    };

    proto._curveFitFormatTime = function(trace, value) {
        if (!Number.isFinite(value)) return 'N/A';
        if (trace && this._fftTimeKind(trace.fileId) === 'datetime') {
            return this._formatCalendarDateTime(trace.fileId, value, this._getTimeVar(trace.fileId));
        }
        return formatFitCoefficient(value);
    };

    // ── Domain and ranges ─────────────────────────────────────────
    proto._curveFitDomain = function(plot) {
        const arrays = [];
        for (const trace of plot?.traces || []) {
            const values = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
            if (values?.length) arrays.push(values);
        }
        const extent = this._finiteSortedExtent(arrays);
        return extent ? { min: extent.min, max: extent.max } : null;
    };

    proto._curveFitTraceDomain = function(trace) {
        if (!trace) return null;
        const values = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        const extent = values?.length ? this._finiteSortedExtent([values]) : null;
        return extent ? { min: extent.min, max: extent.max } : null;
    };

    // [lo, hi] of one fit, in the axis's own time.
    proto._curveFitRange = function(plot, entry) {
        const trace = this._curveFitTraceFor(plot, entry);
        const domain = this._curveFitTraceDomain(trace) || this._curveFitDomain(plot);
        if (!domain) return [0, 1];
        if (entry?.rangeFull) return [domain.min, domain.max];
        let lo = finiteOrNull(entry?.x1);
        let hi = finiteOrNull(entry?.x2);
        if (lo === null || hi === null) { lo = domain.min; hi = domain.max; }
        if (lo > hi) [lo, hi] = [hi, lo];
        const panel = this._curveFitDomain(plot) || domain;
        lo = Math.max(panel.min, Math.min(panel.max, lo));
        hi = Math.max(panel.min, Math.min(panel.max, hi));
        return [lo, hi];
    };

    // Seed a fit's selection from the time view: its middle third, so both
    // green edges sit inside the plot where they can be grabbed.
    proto._seedCurveFitSelection = function(plot, entry) {
        const domain = this._curveFitDomain(plot);
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
        entry.x1 = lo + third;
        entry.x2 = hi - third;
    };

    // ── Fitting ───────────────────────────────────────────────────
    proto._curveFitKey = function(plot, entry, trace, range, info) {
        const token = this._fftDataToken?.(trace.fileId) ?? '';
        return [trace.fileId, trace.varName, entry.model, range[0], range[1], info.scale, token].join('\u0000');
    };

    // Fit one stretch: rows inside [lo, hi], time shifted to t₀ = lo and
    // scaled to the chosen unit. Returns everything the panes and the drawer
    // draw from, so they never refit.
    proto._curveFitEagerRows = function(trace, range) {
        const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName) || [];
        const values = this._getTransformedVariableData(trace.fileId, trace.varName) || [];
        const n = Math.min(times.length || 0, values.length || 0);
        const [start, end] = rangeIndices(n === times.length ? times : times.slice(0, n), range[0], range[1]);
        return { times: times.slice(start, end), values: values.slice(start, end) };
    };

    // One result per fit, in fit order. Eager fits are computed here (and
    // cached by their inputs); lazy ones come from _refreshCurveFitLazy.
    proto._computeCurveFits = function(plot) {
        const state = this._ensureCurveFitState(plot);
        if (!plot._curveFitCache) plot._curveFitCache = new Map();
        const results = [];
        state.fits.forEach((entry, index) => {
            const trace = this._curveFitTraceFor(plot, entry);
            const color = curveFitColor(index);
            const base = { entry, index, trace, color, result: null, lazy: false, lazyStatus: null };
            if (!trace || entry.model === 'none' || !this._isVisible(trace)) {
                results.push(base);
                return;
            }
            const range = this._curveFitRange(plot, entry);
            const info = this._curveFitTimeInfo(plot, trace);
            const key = this._curveFitKey(plot, entry, trace, range, info);
            const cached = plot._curveFitCache.get(entry.id);
            const lazy = !!this.files.get(trace.fileId)?.data?._duckdb;
            if (cached?.key === key && cached.result) {
                results.push({ ...base, result: cached.result, lazy });
                return;
            }
            if (lazy) {
                results.push({ ...base, lazy: true, lazyStatus: cached?.key === key ? cached.status : 'pending', key, range, info });
                return;
            }
            const rows = this._curveFitEagerRows(trace, range);
            const result = this._curveFitFromRows(plot, entry, trace, range, info, rows.times, rows.values);
            plot._curveFitCache.set(entry.id, { key, result, status: 'ok' });
            results.push({ ...base, result });
        });
        plot._curveFitResults = results;
        return results;
    };

    // Lazy fits read their rows from DuckDB (every row in the range, with the
    // panel's transforms), then fit like an eager one. Token-guarded so a
    // superseded query never paints.
    proto._refreshCurveFitLazy = async function(panelId, plot, results) {
        const pending = (results || []).filter(r => r.lazy && !r.result && r.key);
        // One job per fit, under the key it was asked for. A refresh that asks
        // for the same key lets the job finish (a streamed fit of a large file
        // can take minutes, and the panel refreshes for many reasons); a job
        // whose fit now wants another key, or none, is stopped.
        if (!plot._curveFitLazyJobs) plot._curveFitLazyJobs = new Map();
        const jobs = plot._curveFitLazyJobs;
        const wanted = new Map(pending.map(r => [r.entry.id, r.key]));
        for (const [id, job] of jobs) {
            if (wanted.get(id) === job.key) continue;
            job.controller?.abort();
            jobs.delete(id);
        }
        const fresh = pending.filter(r => !jobs.has(r.entry.id));
        for (const r of fresh) {
            jobs.set(r.entry.id, { key: r.key, controller: typeof AbortController === 'function' ? new AbortController() : null });
        }
        for (const r of fresh) {
            const job = jobs.get(r.entry.id);
            if (!job || job.key !== r.key) continue;
            const signal = job.controller?.signal || null;
            const current = () => jobs.get(r.entry.id) === job;
            let entry;
            try {
                const rows = await this._fetchLazyFitRows(r.trace.fileId, [r.trace.varName], r.range, FIT_MAX_LAZY_ROWS);
                if (!current()) continue;
                if (rows.ok) {
                    const result = this._curveFitFromRows(plot, r.entry, r.trace, r.range, r.info,
                        rows.time, rows.valuesByVar.get(r.trace.varName) || []);
                    entry = { key: r.key, result, status: 'ok' };
                } else if (rows.reason === 'tooManyRows') {
                    const result = await this._curveFitStreamed(plot, r, {
                        signal,
                        onProgress: (pass, read) => {
                            if (!current()) return;
                            const text = pass === 'residuals'
                                ? i18n.t('fitLazyResiduals').replace('{rows}', i18n.formatNumber(read))
                                : i18n.t('fitLazyStreaming').replace('{pass}', String(pass)).replace('{rows}', i18n.formatNumber(read));
                            this._setCurveFitStatus(plot, `F${r.index + 1}: ${text}`, 'loading');
                        },
                    });
                    entry = { key: r.key, result, status: 'ok' };
                } else {
                    entry = { key: r.key, result: null, status: 'error' };
                }
            } catch (err) {
                if (err?.name === 'AbortError') continue;
                console.warn('[curve-fit] lazy query failed:', err);
                entry = { key: r.key, result: null, status: 'error' };
            }
            if (!current()) continue;
            jobs.delete(r.entry.id);
            plot._curveFitCache.set(r.entry.id, entry);
            if (this.plots.get(panelId) !== plot || plot.mode !== 'curve-fit') return;
            this._paintCurveFits(panelId, plot, this._computeCurveFits(plot));
        }
    };

    proto._scheduleCurveFitRecompute = function(panelId, options = {}) {
        const plot = this.plots.get(panelId);
        if (!plot?.div || plot.mode !== 'curve-fit') return;
        clearTimeout(plot._curveFitRecomputeTimer);
        const run = () => {
            if (this.plots.get(panelId) !== plot || plot.mode !== 'curve-fit' || !plot.div) return;
            this._setCurveFitStatus(plot, i18n.t('curveFitCalculating'), 'loading');
            this._runAnalysisAfterPaint(
                plot,
                '_curveFitRecomputeRun',
                () => plot.mode === 'curve-fit' && !!plot.div,
                () => {
                    const results = this._computeCurveFits(plot);
                    this._paintCurveFits(panelId, plot, results);
                    this._refreshCurveFitLazy(panelId, plot, results);
                },
            );
        };
        if (options.immediate) run();
        else plot._curveFitRecomputeTimer = setTimeout(run, RECOMPUTE_DEBOUNCE_MS);
    };

    // Draw the results: fit curves on the time pane, residuals below, the
    // drawer, the status line.
    proto._paintCurveFits = function(panelId, plot, results) {
        if (!plot?.div) return;
        this._replaceCurveFitTraces(plot, results);
        this._refreshCurveFitResiduals(plot, results);
        this._renderCurveFitDrawer(panelId, plot, results);
        const fitted = results.filter(r => r.result?.fit?.status === 'ok').length;
        const pending = results.some(r => r.lazy && !r.result && r.lazyStatus === 'pending');
        if (pending) this._setCurveFitStatus(plot, i18n.t('phase2dFitLazyPending'), 'loading');
        else this._setCurveFitStatus(plot, fitted ? i18n.t('curveFitStatus').replace('{count}', String(fitted)) : '', 'muted');
    };

    // ── Time pane ─────────────────────────────────────────────────
    proto._buildCurveFitDataTraces = function(plot) {
        return plot.traces.map((trace, index) => this._buildTimeTrace(trace, null, plot, index)).filter(Boolean);
    };

    proto._curveFitModelName = function(model) {
        return i18n.t(FIT_MODEL_SHORT_KEYS[model] || 'phase2dFitLinear');
    };

    proto._buildCurveFitCurveTraces = function(plot, results = plot._curveFitResults || []) {
        const traces = [];
        const extrapolate = !!this._ensureCurveFitState(plot).extrapolate;
        for (const r of results) {
            const curve = r.result?.curve;
            if (!curve?.x?.length) continue;
            const name = `F${r.index + 1} · ${this._curveFitModelName(r.entry.model)}`;
            traces.push({
                x: curve.x,
                y: curve.y,
                type: 'scatter',
                mode: 'lines',
                name,
                yaxis: this._traceYAxis(r.trace, plot),
                line: { color: r.color, width: 2.5, dash: 'dash' },
                customdata: curve.tPrime,
                hovertemplate: `<b>${this._escapeHTML(name)}</b><br>t′ = %{customdata:.4g} ${this._escapeHTML(r.result.unit || '')}`
                    + '<br>ŷ = %{y:.4g}<extra></extra>',
                meta: { curveFitIndex: r.index },
            });
            const outside = extrapolate ? this._curveFitExtrapolatedCurve(r) : null;
            if (outside) {
                traces.push({
                    x: outside.x,
                    y: outside.y,
                    type: 'scatter',
                    mode: 'lines',
                    name: `${name} (${i18n.t('curveFitExtrapolatedShort')})`,
                    showlegend: false,
                    yaxis: this._traceYAxis(r.trace, plot),
                    line: { color: r.color, width: 1.5, dash: 'dot' },
                    opacity: 0.8,
                    customdata: outside.tPrime,
                    hovertemplate: `<b>${this._escapeHTML(name)}</b> (${this._escapeHTML(i18n.t('curveFitExtrapolatedShort'))})`
                        + `<br>t′ = %{customdata:.4g} ${this._escapeHTML(r.result.unit || '')}`
                        + '<br>ŷ = %{y:.4g}<extra></extra>',
                    meta: { curveFitIndex: r.index, curveFitExtrapolated: true },
                });
            }
        }
        return traces;
    };

    // The fit's equation over the rest of its signal's time axis: before and
    // after the fitted stretch, joined by a gap, in the panel's time units.
    proto._curveFitExtrapolatedCurve = function(r) {
        const fit = r.result?.fit;
        if (fit?.status !== 'ok' || !r.trace) return null;
        const domain = this._curveFitTraceDomain(r.trace);
        const { t0, scale } = r.result;
        if (!domain || !Number.isFinite(t0) || !(scale > 0)) return null;
        const pMin = (domain.min - t0) / scale;
        const pMax = (domain.max - t0) / scale;
        const span = (fit.maxX - fit.minX) || (pMax - pMin) || 1;
        const tPrime = [];
        const y = [];
        const segment = (a, b) => {
            if (!(b > a)) return;
            // As dense as the fitted curve, at least a handful of points.
            const count = Math.max(8, Math.min(2000, Math.ceil(200 * (b - a) / span)));
            const sampled = buildFitCurve({ ...fit, minX: a, maxX: b }, count);
            if (tPrime.length) { tPrime.push(NaN); y.push(null); }
            tPrime.push(...sampled.x);
            y.push(...sampled.y.map(v => (Number.isFinite(v) ? v : null)));
        };
        segment(pMin, fit.minX);
        segment(fit.maxX, pMax);
        if (!tPrime.length) return null;
        const timeVar = this._getTimeVar(r.trace.fileId);
        const t = tPrime.map(v => (Number.isFinite(v) ? t0 + v * scale : NaN));
        const x = this._plotlyTimeArray(r.trace.fileId, t, timeVar);
        return { x: Array.from(x, (v, i) => (Number.isFinite(t[i]) ? v : null)), y, tPrime };
    };

    // The fit curves sit after the panel's own traces, so the time-series
    // refresh (which restyles by trace index) never reaches them.
    proto._replaceCurveFitTraces = function(plot, results) {
        // Chained: two paints in flight must not interleave their delete/add.
        const run = () => {
            const div = plot?.div;
            if (!div?.data || plot.mode !== 'curve-fit') return Promise.resolve();
            const fitIndices = [];
            div.data.forEach((trace, index) => { if (trace?.meta?.curveFitIndex !== undefined) fitIndices.push(index); });
            const next = this._buildCurveFitCurveTraces(plot, results);
            const apply = () => (next.length && plot.div === div ? Plotly.addTraces(div, next) : null);
            return Promise.resolve(fitIndices.length ? Plotly.deleteTraces(div, fitIndices) : null)
                .then(apply)
                .then(() => this._updateCurveFitSelectionShapes(plot));
        };
        plot._curveFitPaintChain = Promise.resolve(plot._curveFitPaintChain).catch(() => {}).then(run);
        return plot._curveFitPaintChain;
    };

    proto._buildCurveFitTimeLayout = function(plot) {
        const layout = this._buildTimeLayout(plot);
        const overlay = this._curveFitSelectionOverlay(plot);
        layout.shapes = overlay.shapes;
        layout.annotations = [...(layout.annotations || []), ...overlay.annotations];
        layout.margin = { ...(layout.margin || {}), t: 18 };
        return layout;
    };

    // Every fit with a selection draws its range: the active one as the green
    // band that can be dragged, the others grey, each labelled F1, F2…
    proto._curveFitSelectionOverlay = function(plot) {
        const state = this._ensureCurveFitState(plot);
        const shapes = [];
        const annotations = [];
        const first = plot.traces?.[0];
        const timeVar = first ? this._getTimeVar(first.fileId) : null;
        const toX = (v) => (first ? this._plotlyTimeValue(first.fileId, v, timeVar) : v);
        state.fits.forEach((entry, index) => {
            if (entry.rangeFull) return;
            const [lo, hi] = this._curveFitRange(plot, entry);
            const x0 = toX(lo);
            const x1 = toX(hi);
            const active = index === state.activeFit;
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
            const mid = lo + (hi - lo) / 2;
            annotations.push({
                xref: 'x', yref: 'paper', x: toX(mid), y: 1, yanchor: 'bottom', showarrow: false,
                text: `<b>F${index + 1}</b>`,
                font: { size: 11, color: active ? '#2e7d32' : curveFitColor(index) },
                _curveFitLabel: true,
            });
        });
        return { shapes, annotations };
    };

    proto._updateCurveFitSelectionShapes = function(plot) {
        if (!plot?.div?._fullLayout || plot.mode !== 'curve-fit') return Promise.resolve();
        const overlay = this._curveFitSelectionOverlay(plot);
        const kept = (plot.div.layout?.annotations || []).filter(a => !a._curveFitLabel && !/^<b>F\d+<\/b>$/.test(String(a.text || '')));
        return Plotly.relayout(plot.div, { shapes: overlay.shapes, annotations: [...kept, ...overlay.annotations] });
    };

    proto._refreshCurveFitAll = function(panelId, plot = this.plots.get(panelId), options = {}) {
        if (!plot?.div || plot.mode !== 'curve-fit') return Promise.resolve();
        const xRange = options.preserveView ? plot.div._fullLayout?.xaxis?.range : null;
        const layout = this._buildCurveFitTimeLayout(plot);
        if (Array.isArray(xRange)) layout.xaxis = { ...(layout.xaxis || {}), range: xRange.slice(), autorange: false };
        const traces = [...this._buildCurveFitDataTraces(plot), ...this._buildCurveFitCurveTraces(plot)];
        return Plotly.react(plot.div, traces, layout, this._getPlotlyConfig()).then(() => {
            this._installLegendHoverHint?.(plot.div);
            this._refreshTimeseriesVisuals(panelId, plot);
            this._scheduleCurveFitRecompute(panelId, { immediate: true });
        });
    };

    // ── Residual pane ─────────────────────────────────────────────
    proto._buildCurveFitResidualLayout = function(plot) {
        const base = this._buildTimeLayout(plot);
        const { fontColor } = this._colors();
        const layout = {
            ...base,
            shapes: [],
            annotations: [],
            showlegend: false,
            margin: { ...(base.margin || {}), t: 6 },
            yaxis: {
                ...(base.yaxis || {}),
                title: { text: i18n.t('curveFitResidualAxis') },
                zeroline: true,
                zerolinecolor: fontColor,
                zerolinewidth: 1,
                autorange: true,
                type: 'linear',
            },
        };
        delete layout.yaxis2;
        const timeRange = plot.div?._fullLayout?.xaxis?.range;
        if (Array.isArray(timeRange)) layout.xaxis = { ...(layout.xaxis || {}), range: timeRange.slice(), autorange: false };
        return layout;
    };

    proto._refreshCurveFitResiduals = function(plot, results = plot._curveFitResults || []) {
        const div = plot?.curveFitResidualDiv;
        if (!div) return Promise.resolve();
        const traces = [];
        for (const r of results) {
            const residual = r.result?.residual;
            if (!residual?.x?.length) continue;
            const name = `F${r.index + 1}`;
            traces.push({
                x: residual.x,
                y: residual.y,
                type: 'scatter',
                mode: 'lines',
                name,
                line: { color: r.color, width: 1.2 },
                hovertemplate: `<b>${name}</b> y − ŷ = %{y:.4g}<extra></extra>`,
            });
        }
        return Plotly.react(div, traces, this._buildCurveFitResidualLayout(plot), this._getPlotlyConfig());
    };

    // The residual pane follows the time pane's x view, so a residual sits
    // under the sample it belongs to.
    proto._syncCurveFitResidualX = function(plot) {
        const range = plot?.div?._fullLayout?.xaxis?.range;
        const div = plot?.curveFitResidualDiv;
        if (!div?._fullLayout || !Array.isArray(range)) return;
        const current = div._fullLayout.xaxis?.range;
        if (Array.isArray(current) && current[0] === range[0] && current[1] === range[1]) return;
        plot._curveFitSyncingResidual = true;
        Promise.resolve(Plotly.relayout(div, { 'xaxis.range': range.slice(), 'xaxis.autorange': false }))
            .finally(() => { plot._curveFitSyncingResidual = false; });
    };

    // ── Chart ─────────────────────────────────────────────────────
    proto._createCurveFitChart = function(panelId, panelEl) {
        const plot = this.plots.get(panelId);
        if (!this._hasContent(plot)) return;
        const state = this._ensureCurveFitState(plot);
        const restoreView = plot._pendingViewRestore || null;
        delete plot._pendingViewRestore;
        this._consumeSessionViewRestore(plot);
        plot._curveFitCache = new Map();

        const placeholder = panelEl.querySelector('.layout-panel-placeholder');
        if (placeholder) placeholder.style.display = 'none';
        panelEl.querySelector('.curve-fit-container')?.remove();

        const container = document.createElement('div');
        container.className = `fft-container curve-fit-container fft-layout-${state.layout}${state.residualsHidden ? ' curve-fit-residuals-hidden' : ''}`;
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
            const current = this._ensureCurveFitState(plot).layout;
            this._setCurveFitLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
        });
        layoutBtn.setAttribute('aria-label', i18n.t('fftLayoutToggle'));
        const residualBtn = makeButton('fft-tool-btn curve-fit-residuals-btn',
            i18n.t(state.residualsHidden ? 'curveFitShowResiduals' : 'curveFitHideResiduals'),
            i18n.t('curveFitResidualsTooltip'),
            () => this._toggleCurveFitResiduals(panelId));
        residualBtn.classList.toggle('active', state.residualsHidden);
        residualBtn.setAttribute('aria-pressed', String(state.residualsHidden));
        layoutGroup.append(layoutBtn, residualBtn);
        const actionGroup = document.createElement('div');
        actionGroup.className = 'fft-topbar-group';
        const optionsBtn = makeButton('fft-tool-btn fft-options-btn', i18n.t('fftOptionsLabel'), i18n.t('fftOptionsToggle'), () => this._toggleCurveFitOptions(panelId));
        optionsBtn.classList.toggle('active', state.optionsVisible);
        optionsBtn.setAttribute('aria-pressed', String(state.optionsVisible));
        actionGroup.append(
            makeButton('fft-tool-btn', i18n.t('fftResetLabel'), i18n.t('fftResetView'), () => this._resetCurveFitView(panelId)),
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
        const residualPane = document.createElement('div');
        residualPane.className = 'fft-pane fft-spectrum-pane curve-fit-residual-pane';
        const splitter = document.createElement('div');
        splitter.className = 'fft-splitter';
        splitter.setAttribute('role', 'separator');
        const timeDiv = document.createElement('div');
        timeDiv.className = 'plotly-container plotly-mode-curve-fit-time';
        const residualDiv = document.createElement('div');
        residualDiv.className = 'plotly-container plotly-mode-curve-fit-residual';
        timePane.appendChild(timeDiv);
        residualPane.appendChild(residualDiv);
        plotArea.append(timePane, splitter, residualPane);

        const options = document.createElement('aside');
        options.className = 'fft-options phase2d-fit-options curve-fit-options';
        options.hidden = !state.optionsVisible;
        options.setAttribute('aria-label', i18n.t('phase2dFitResultsTitle'));
        workspace.append(plotArea, createEdgeToggle({
            side: 'right',
            collapsed: !state.optionsVisible,
            hideKey: 'edgeHideOptions',
            showKey: 'edgeShowOptions',
            onToggle: () => this._toggleCurveFitOptions(panelId),
        }), options);
        container.append(topbar, workspace);
        panelEl.appendChild(container);

        plot.curveFitContainer = container;
        plot.curveFitResidualDiv = residualDiv;
        plot.curveFitOptionsEl = options;
        plot.div = timeDiv;
        plot._curveFitResults = [];
        this._renderCurveFitDrawer(panelId, plot, []);

        const config = this._getPlotlyConfig();
        Promise.all([
            Plotly.newPlot(timeDiv, this._buildCurveFitDataTraces(plot), this._buildCurveFitTimeLayout(plot), config),
            Plotly.newPlot(residualDiv, [], this._buildCurveFitResidualLayout(plot), config),
        ]).then(() => {
            if (this.plots.get(panelId) !== plot || plot.div !== timeDiv) return;
            this._refreshActionBtns(panelId);
            this._installCurveFitPlotHandlers(panelId, plot);
            this._installCursorHandlers?.(panelId, plot);
            this._installCurveFitSelectionHandlers(panelId, plot);
            this._installCurveFitSplitterHandlers(panelId, plot);
            this._installWheelPan(panelId, plot, timeDiv, { finalize: xRange => this._onRelayout(panelId, { 'xaxis.range': xRange }) });
            this._installRightButtonPan(panelId, plot, timeDiv, { finalize: xRange => this._onRelayout(panelId, { 'xaxis.range': xRange }) });
            this._syncCursorDisplay?.(panelId, plot);
            const viewPromise = restoreView ? this._restorePlotView(plot, restoreView) : Promise.resolve();
            Promise.resolve(viewPromise).then(() => {
                this._refreshTimeseriesVisuals(panelId, plot);
                // A fit with no range yet is seeded once the view exists.
                const state2 = this._ensureCurveFitState(plot);
                let seeded = false;
                for (const entry of state2.fits) {
                    if (!entry.rangeFull && (entry.x1 === null || entry.x2 === null)) {
                        this._seedCurveFitSelection(plot, entry);
                        seeded = true;
                    }
                }
                if (seeded) this._updateCurveFitSelectionShapes(plot);
                this._bindViewHistory(panelId, plot);
                this._scheduleCurveFitRecompute(panelId, { immediate: true });
            });
            let timer;
            const observer = new ResizeObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    if (plot.div?.isConnected) Plotly.Plots.resize(plot.div);
                    if (plot.curveFitResidualDiv?.isConnected && !this._ensureCurveFitState(plot).residualsHidden) {
                        Plotly.Plots.resize(plot.curveFitResidualDiv);
                    }
                }, 50);
            });
            observer.observe(panelEl);
            plot.resizeObserver = observer;
        });
    };

    proto._installCurveFitPlotHandlers = function(panelId, plot) {
        if (!plot?.div || plot._curveFitHandlerDiv === plot.div) return;
        plot._curveFitHandlerDiv = plot.div;
        let lastShift = false;
        plot.div.addEventListener('mousedown', event => { lastShift = !!event.shiftKey; }, { capture: true });
        plot.div.addEventListener('contextmenu', event => {
            if (this._handleCurveFitLegendContextMenu(panelId, plot, plot.div, event)) return;
            event.preventDefault();
        });
        plot.div.on('plotly_legendclick', eventData => {
            if (eventData.event?.button !== undefined && eventData.event.button !== 0) {
                lastShift = false;
                return false;
            }
            const clicked = eventData.data?.[eventData.curveNumber];
            // A fit curve's entry selects that fit in the drawer.
            const fitIndex = clicked?.meta?.curveFitIndex;
            if (fitIndex !== undefined) {
                this._setCurveFitActive(panelId, fitIndex);
                lastShift = false;
                return false;
            }
            this._handleCurveFitLegendClick(panelId, plot, clicked?.name, !!(eventData.event?.shiftKey || lastShift));
            lastShift = false;
            return false;
        });
        plot.div.on('plotly_legenddoubleclick', () => false);
        plot.div.on('plotly_afterplot', () => this._installLegendHoverHint?.(plot.div));
        plot.div.on('plotly_relayout', eventData => {
            this._onRelayout(panelId, eventData);
            this._syncCurveFitResidualX(plot);
        });
        plot.div.on('plotly_doubleclick', () => { this._autoScalePlotTimeOnly(plot); return false; });
        const residual = plot.curveFitResidualDiv;
        residual?.on('plotly_doubleclick', () => {
            Plotly.relayout(residual, { 'yaxis.autorange': true });
            this._autoScalePlotTimeOnly(plot);
            return false;
        });
        // Zooming the residuals in time moves the time pane with them.
        residual?.on('plotly_relayout', eventData => {
            if (plot._curveFitSyncingResidual) return;
            const r0 = eventData?.['xaxis.range[0]'] ?? eventData?.['xaxis.range']?.[0];
            const r1 = eventData?.['xaxis.range[1]'] ?? eventData?.['xaxis.range']?.[1];
            if (r0 === undefined || r1 === undefined || !plot.div) return;
            Plotly.relayout(plot.div, { 'xaxis.range': [r0, r1], 'xaxis.autorange': false });
        });
    };

    // ── Legend ────────────────────────────────────────────────────
    proto._handleCurveFitLegendClick = function(panelId, plot, name, shiftClick = false) {
        const trace = (plot.traces || []).find(candidate => this._traceName(candidate.varName, candidate.fileId) === name);
        if (!trace) return;
        if (shiftClick) {
            this._removeCurveFitTraceFromLegend(panelId, plot, trace);
            return;
        }
        trace.visible = trace.visible === 'legendonly' ? true : 'legendonly';
        this._refreshCurveFitAll(panelId, plot, { preserveView: true });
    };

    proto._handleCurveFitLegendContextMenu = function(panelId, plot, div, event) {
        const fullTrace = this._legendFullTraceFromContextEvent?.(div, event);
        const name = fullTrace?.name;
        const trace = (plot.traces || []).find(candidate => this._traceName(candidate.varName, candidate.fileId) === name);
        if (!trace) return false;
        event.preventDefault();
        event.stopPropagation();
        this._showLegendTraceMenu(event, trace, {
            onShow: () => this._setCurveFitLegendSelection(panelId, plot, trace, 'show'),
            onHide: () => this._setCurveFitLegendSelection(panelId, plot, trace, 'hide'),
            onOnly: () => this._setCurveFitLegendSelection(panelId, plot, trace, 'only'),
            onRemove: () => this._removeCurveFitTraceFromLegend(panelId, plot, trace),
        });
        return true;
    };

    proto._setCurveFitLegendSelection = function(panelId, plot, selectedTrace, action) {
        for (const trace of plot.traces || []) {
            let visible = trace.visible === 'legendonly' || trace.visible === false ? 'legendonly' : true;
            if (action === 'show' && trace === selectedTrace) visible = true;
            if (action === 'hide' && trace === selectedTrace) visible = 'legendonly';
            if (action === 'only') visible = trace === selectedTrace ? true : 'legendonly';
            trace.visible = visible;
        }
        this._refreshCurveFitAll(panelId, plot, { preserveView: true });
    };

    proto._removeCurveFitTraceFromLegend = function(panelId, plot, trace) {
        const index = (plot.traces || []).indexOf(trace);
        if (index >= 0) plot.traces.splice(index, 1);
        if (!plot.traces.length) this._clearPanel(panelId);
        else this._rebuildPanel(panelId, { preserveView: true });
    };

    // ── Selection band (the active fit's range) ───────────────────
    proto._installCurveFitSelectionHandlers = function(panelId, plot) {
        if (!plot?.div || plot._curveFitSelectionDiv === plot.div) return;
        plot._curveFitSelectionDiv = plot.div;
        let dragging = null;
        const hitTest = (event) => {
            const entry = this._curveFitActiveEntry(plot);
            if (!entry || entry.rangeFull) return null;
            if (!this._eventInsidePlotArea(plot.div, event)) return null;
            const x = this._eventToXValue(plot.div, event);
            if (!Number.isFinite(x)) return null;
            const domain = this._curveFitDomain(plot);
            if (!domain) return null;
            const [lo, hi] = this._curveFitRange(plot, entry);
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
        };
        plot.div.addEventListener('mousemove', event => { if (!dragging) setCursorHint(hitTest(event)); });
        plot.div.addEventListener('mouseleave', () => { if (!dragging) setCursorHint(null); });
        const onDown = (event) => {
            if (event.button !== 0) return;
            const hit = hitTest(event);
            if (!hit) return;
            const entry = this._curveFitActiveEntry(plot);
            const x = this._eventToXValue(plot.div, event);
            const [lo, hi] = this._curveFitRange(plot, entry);
            dragging = { hit, startX: x, startLo: lo, startHi: hi, entry };
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            document.body.classList.add('fft-selection-dragging');
            document.body.classList.toggle('fft-selection-moving', hit === 'move');
        };
        plot.div.addEventListener('mousedown', onDown, true);
        const onMove = (event) => {
            if (!dragging || !plot.div) return;
            const domain = this._curveFitDomain(plot);
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
            dragging.entry.x1 = Math.max(domain.min, Math.min(domain.max, lo));
            dragging.entry.x2 = Math.max(domain.min, Math.min(domain.max, hi));
            this._updateCurveFitSelectionShapes(plot);
            this._syncCurveFitRangeInputs(plot);
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = null;
            document.body.classList.remove('fft-selection-dragging', 'fft-selection-moving');
            setCursorHint(null);
            this._scheduleCurveFitRecompute(panelId);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        plot._curveFitSelectionDocListeners = { move: onMove, up: onUp };
        this._alsoDragWithTouch(plot.div, plot, '_curveFitSelectionTouchDiv', { hitTest, onDown, onMove, onUp });
    };

    proto._installCurveFitSplitterHandlers = function(panelId, plot) {
        const splitter = plot?.curveFitContainer?.querySelector('.fft-splitter');
        if (!splitter || splitter._curveFitBound) return;
        splitter._curveFitBound = true;
        let dragging = false;
        const apply = (event) => {
            const container = plot.curveFitContainer;
            if (!container) return;
            const state = this._ensureCurveFitState(plot);
            const rect = container.querySelector('.fft-plot-area')?.getBoundingClientRect();
            if (!rect?.width || !rect?.height) return;
            const fraction = state.layout === 'horizontal'
                ? (event.clientX - rect.left) / rect.width
                : (event.clientY - rect.top) / rect.height;
            state.split = Math.max(0.2, Math.min(0.85, fraction));
            container.style.setProperty('--fft-split', `${Math.round(state.split * 1000) / 10}%`);
            if (plot.div) Plotly.Plots.resize(plot.div);
            if (plot.curveFitResidualDiv) Plotly.Plots.resize(plot.curveFitResidualDiv);
        };
        splitter.addEventListener('mousedown', event => { dragging = true; event.preventDefault(); document.body.classList.add('fft-split-dragging'); });
        const onMove = event => { if (dragging) apply(event); };
        const onUp = () => { dragging = false; document.body.classList.remove('fft-split-dragging'); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        plot._curveFitSplitterDocListeners = { move: onMove, up: onUp };
        void panelId;
    };

    proto._cleanupCurveFitDocListeners = function(plot) {
        for (const key of ['_curveFitSelectionDocListeners', '_curveFitSplitterDocListeners']) {
            const listeners = plot?.[key];
            if (!listeners) continue;
            document.removeEventListener('mousemove', listeners.move);
            document.removeEventListener('mouseup', listeners.up);
            plot[key] = null;
        }
        clearTimeout(plot?._curveFitRecomputeTimer);
        this._stopLazyFits?.(plot);
    };

    // ── Top bar ───────────────────────────────────────────────────
    proto._setCurveFitLayout = function(panelId, layout) {
        const plot = this.plots.get(panelId);
        if (!plot?.curveFitContainer || !CURVE_FIT_LAYOUTS.has(layout)) return;
        this._ensureCurveFitState(plot).layout = layout;
        plot.curveFitContainer.classList.toggle('fft-layout-horizontal', layout === 'horizontal');
        plot.curveFitContainer.classList.toggle('fft-layout-vertical', layout === 'vertical');
        if (plot.div) Plotly.Plots.resize(plot.div);
        if (plot.curveFitResidualDiv) Plotly.Plots.resize(plot.curveFitResidualDiv);
    };

    proto._toggleCurveFitResiduals = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot?.curveFitContainer) return;
        const state = this._ensureCurveFitState(plot);
        state.residualsHidden = !state.residualsHidden;
        plot.curveFitContainer.classList.toggle('curve-fit-residuals-hidden', state.residualsHidden);
        const button = plot.curveFitContainer.querySelector('.curve-fit-residuals-btn');
        if (button) {
            button.textContent = i18n.t(state.residualsHidden ? 'curveFitShowResiduals' : 'curveFitHideResiduals');
            button.classList.toggle('active', state.residualsHidden);
            button.setAttribute('aria-pressed', String(state.residualsHidden));
        }
        if (plot.div) Plotly.Plots.resize(plot.div);
        if (!state.residualsHidden && plot.curveFitResidualDiv) {
            Plotly.Plots.resize(plot.curveFitResidualDiv);
            this._syncCurveFitResidualX(plot);
        }
    };

    proto._toggleCurveFitOptions = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot?.curveFitContainer) return;
        const state = this._ensureCurveFitState(plot);
        state.optionsVisible = !state.optionsVisible;
        syncEdgeToggle(plot.curveFitContainer, !state.optionsVisible);
        if (plot.curveFitOptionsEl) plot.curveFitOptionsEl.hidden = !state.optionsVisible;
        const button = plot.curveFitContainer.querySelector('.fft-options-btn');
        if (button) {
            button.classList.toggle('active', state.optionsVisible);
            button.setAttribute('aria-pressed', String(state.optionsVisible));
        }
        if (plot.div) Plotly.Plots.resize(plot.div);
        if (plot.curveFitResidualDiv) Plotly.Plots.resize(plot.curveFitResidualDiv);
    };

    // Reset the view, not the fits: they are work the user did.
    proto._resetCurveFitView = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot?.div) return;
        this._autoScaleCurveFitPanel(panelId, plot);
    };

    proto._autoScaleCurveFitPanel = function(panelId, plot = this.plots.get(panelId)) {
        if (!plot?.div) return Promise.resolve();
        const residual = plot.curveFitResidualDiv;
        return Promise.all([
            this._autoScalePlotTimeOnly(plot),
            residual?._fullLayout ? Plotly.relayout(residual, { 'yaxis.autorange': true }) : null,
        ]);
    };

    proto._autoScaleCurveFitAxis = function(plot, axis) {
        const residual = plot?.curveFitResidualDiv;
        if (!residual?._fullLayout) return Promise.resolve();
        return Plotly.relayout(residual, axis === 'x' ? { 'xaxis.autorange': true } : { 'yaxis.autorange': true });
    };

    proto._setCurveFitStatus = function(plot, message, type = 'muted') {
        const el = plot?.curveFitContainer?.querySelector('.fft-status');
        if (!el) return;
        el.textContent = message || '';
        el.className = `fft-status fft-status-${type}`;
        el.title = message || '';
    };

    // ── Editing fits ──────────────────────────────────────────────
    proto._setCurveFitActive = function(panelId, index) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureCurveFitState(plot);
        state.activeFit = Math.max(0, Math.min(state.fits.length - 1, Number(index) || 0));
        this._updateCurveFitSelectionShapes(plot);
        this._renderCurveFitDrawer(panelId, plot, plot._curveFitResults || []);
    };

    proto._addCurveFit = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureCurveFitState(plot);
        if (state.fits.length >= CURVE_FIT_MAX_FITS) return;
        const current = this._curveFitActiveEntry(plot);
        const entry = defaultCurveFitEntry({ fileId: current?.fileId ?? null, varName: current?.varName ?? null });
        this._seedCurveFitSelection(plot, entry);
        state.fits.push(entry);
        state.activeFit = state.fits.length - 1;
        this._updateCurveFitSelectionShapes(plot);
        this._scheduleCurveFitRecompute(panelId, { immediate: true });
    };

    proto._removeCurveFit = function(panelId, index) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureCurveFitState(plot);
        const removed = state.fits.splice(index, 1)[0];
        if (removed) plot._curveFitCache?.delete(removed.id);
        if (!state.fits.length) {
            const entry = defaultCurveFitEntry();
            this._curveFitTraceFor(plot, entry);
            this._seedCurveFitSelection(plot, entry);
            state.fits.push(entry);
        }
        state.activeFit = Math.max(0, Math.min(state.fits.length - 1, index - (index > 0 ? 1 : 0)));
        this._updateCurveFitSelectionShapes(plot);
        this._scheduleCurveFitRecompute(panelId, { immediate: true });
    };

    proto._updateCurveFitEntry = function(panelId, patch) {
        const plot = this.plots.get(panelId);
        const entry = plot ? this._curveFitActiveEntry(plot) : null;
        if (!entry) return;
        Object.assign(entry, patch);
        this._updateCurveFitSelectionShapes(plot);
        this._scheduleCurveFitRecompute(panelId, { immediate: true });
    };

    // ── Help ──────────────────────────────────────────────────────
    proto._showCurveFitHelp = function() {
        Modal.alert(
            i18n.t('curveFitHelpTitle'),
            `<div class="help-doc">${i18n.t('curveFitHelp')}${i18n.t('fitExpFamilyHelp')}</div>`,
            { html: true, icon: false, className: 'modal-dialog-help phase2d-fit-help-dialog' },
        );
    };

    proto._curveFitWarningText = function(r) {
        if (!r.result) {
            if (r.lazy) {
                if (r.lazyStatus === 'error') return i18n.t('phase2dFitLazyError');
                return i18n.t('phase2dFitLazyPending');
            }
            return '';
        }
        const fit = r.result.fit;
        if (!fit) return i18n.t('phase2dFitNoData');
        const map = {
            'insufficient-n': i18n.t('phase2dFitInsufficientN'),
            'x-constant': i18n.t('phase2dFitNoData'),
            'y-constant': i18n.t('phase2dFitYConstant'),
            singular: i18n.t('phase2dFitSingular'),
            'coefficient-overflow': i18n.t('fitCoefficientOverflow'),
        };
        if (fit.status !== 'ok' && !fit.warning) return i18n.t('phase2dFitNoData');
        return fit.warning ? (map[fit.warning] || fit.warning) : '';
    };

    // ── Drawer ────────────────────────────────────────────────────
    // 1) which fit, add/remove; 2) its signal; 3) its model (+ help);
    // 4) its range; 5) the unit of t′ (calendar axes); 6) its result.
    proto._renderCurveFitDrawer = function(panelId, plot = this.plots.get(panelId), results = plot?._curveFitResults || []) {
        const drawer = plot?.curveFitOptionsEl;
        if (!drawer) return;
        const state = this._ensureCurveFitState(plot);
        drawer.replaceChildren();
        if (!plot.traces.length) {
            const empty = document.createElement('p');
            empty.className = 'phase2d-fit-empty';
            empty.textContent = i18n.t('curveFitNoSignals');
            drawer.appendChild(empty);
            return;
        }
        const entry = this._curveFitActiveEntry(plot);
        const trace = this._curveFitTraceFor(plot, entry);
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

        // 1) Fit list
        const fitSelect = document.createElement('select');
        fitSelect.className = 'phase2d-fit-pair-select curve-fit-select';
        fitSelect.setAttribute('aria-label', i18n.t('curveFitFit'));
        state.fits.forEach((fit, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            const fitTrace = (plot.traces || []).find(t => t.varName === fit.varName && t.fileId === fit.fileId);
            const signal = fitTrace ? this._traceName(fitTrace.varName, fitTrace.fileId, { units: false }) : '—';
            const model = fit.model === 'none' ? i18n.t('phase2dFitOff') : this._curveFitModelName(fit.model);
            option.textContent = `F${index + 1} · ${model} · ${signal}`;
            option.title = option.textContent;
            option.selected = index === state.activeFit;
            fitSelect.appendChild(option);
        });
        fitSelect.addEventListener('change', () => this._setCurveFitActive(panelId, Number(fitSelect.value)));
        const fitButtons = document.createElement('div');
        fitButtons.className = 'curve-fit-list-actions';
        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'fft-tool-btn curve-fit-add-btn';
        addButton.textContent = i18n.t('curveFitAdd');
        addButton.title = i18n.t('curveFitAddTip');
        addButton.disabled = state.fits.length >= CURVE_FIT_MAX_FITS;
        addButton.addEventListener('click', () => this._addCurveFit(panelId));
        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'fft-tool-btn curve-fit-remove-btn';
        removeButton.textContent = i18n.t('curveFitRemove');
        removeButton.title = i18n.t('curveFitRemoveTip');
        removeButton.addEventListener('click', () => this._removeCurveFit(panelId, state.activeFit));
        fitButtons.append(addButton, removeButton);
        const swatch = document.createElement('span');
        swatch.className = 'phase2d-fit-swatch curve-fit-swatch';
        swatch.style.background = curveFitColor(state.activeFit);
        const fitField = field('curveFitFit', fitSelect, fitButtons);
        fitField.querySelector('.phase2d-fit-field-label').prepend(swatch);
        drawer.appendChild(fitField);

        // 2) Signal
        const signalSelect = document.createElement('select');
        signalSelect.className = 'phase2d-fit-pair-select curve-fit-signal-select';
        signalSelect.setAttribute('aria-label', i18n.t('curveFitSignal'));
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
            if (picked) this._updateCurveFitEntry(panelId, { varName: picked.varName, fileId: picked.fileId });
        });
        drawer.appendChild(field('curveFitSignal', signalSelect));

        // 3) Model
        const typeSelect = document.createElement('select');
        typeSelect.className = 'phase2d-fit-type-select';
        typeSelect.setAttribute('aria-label', i18n.t('phase2dFitType'));
        FIT_MODEL_OPTIONS.forEach(({ id, key }) => {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = i18n.t(key);
            option.selected = id === entry.model;
            typeSelect.appendChild(option);
        });
        typeSelect.addEventListener('change', () => this._updateCurveFitEntry(panelId, { model: typeSelect.value }));
        const typeField = field('phase2dFitType', typeSelect, helpButton('curveFitHelpTitle', () => this._showCurveFitHelp()));
        typeField.classList.add('phase2d-fit-type-field');
        drawer.appendChild(typeField);

        // 4) Range
        const usesCalendar = !!trace && this._fftTimeKind(trace.fileId) === 'datetime';
        const makeRow = (labelText, control, tooltip = '') => {
            const label = document.createElement('label');
            label.className = 'fft-option-row';
            if (tooltip) label.title = tooltip;
            const span = document.createElement('span');
            span.textContent = labelText;
            label.append(span, control);
            return label;
        };
        const segmented = document.createElement('div');
        segmented.className = 'fft-segmented';
        const makeSegment = (labelKey, tooltipKey, isFull) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = i18n.t(labelKey);
            button.title = i18n.t(tooltipKey);
            button.classList.toggle('active', !!entry.rangeFull === isFull);
            button.addEventListener('click', (event) => {
                event.preventDefault();
                if (!!entry.rangeFull === isFull) return;
                const patch = { rangeFull: isFull };
                if (!isFull && (entry.x1 === null || entry.x2 === null)) {
                    const probe = { ...entry };
                    this._seedCurveFitSelection(plot, probe);
                    patch.x1 = probe.x1;
                    patch.x2 = probe.x2;
                }
                this._updateCurveFitEntry(panelId, patch);
            });
            return button;
        };
        segmented.append(
            makeSegment('fftRangeFull', 'curveFitRangeFullTooltip', true),
            makeSegment('fftRangeSelection', 'curveFitRangeSelectionTooltip', false),
        );
        drawer.appendChild(makeRow(i18n.t('fftRange'), segmented));
        const [lo, hi] = this._curveFitRange(plot, entry);
        const makeInput = (key, value) => {
            const input = document.createElement('input');
            input.type = usesCalendar ? 'datetime-local' : 'number';
            input.step = usesCalendar ? '1' : 'any';
            input.className = 'fft-number-input';
            input.dataset.curveFitKey = key;
            input.value = usesCalendar ? msToDatetimeInput(value) : formatInputValue(value);
            input.disabled = !!entry.rangeFull;
            input.addEventListener('change', () => {
                const n = usesCalendar ? datetimeInputToMs(input.value) : Number(input.value);
                if (!Number.isFinite(n)) return;
                const [curLo, curHi] = this._curveFitRange(plot, entry);
                const patch = key === 'x1' ? { x1: n, x2: curHi } : { x1: curLo, x2: n };
                this._updateCurveFitEntry(panelId, patch);
            });
            return input;
        };
        const rangeGrid = document.createElement('div');
        rangeGrid.className = 'fft-range-grid';
        const bound = (labelKey, key, value) => {
            const wrap = document.createElement('div');
            wrap.className = 'fft-range-bound';
            if (usesCalendar) wrap.classList.add('fft-range-bound-datetime');
            wrap.appendChild(makeRow(i18n.t(labelKey), makeInput(key, value)));
            return wrap;
        };
        rangeGrid.append(bound('fftRangeStart', 'x1', lo), bound('fftRangeEnd', 'x2', hi));
        drawer.appendChild(rangeGrid);
        // Extrapolate: the drawn curves run over the whole signal (dotted
        // outside their range), and a saved fit is not NaN outside it.
        const extrapolateLabel = document.createElement('label');
        extrapolateLabel.className = 'curve-fit-extrapolate';
        extrapolateLabel.title = i18n.t('curveFitExtrapolateTip');
        const extrapolateBox = document.createElement('input');
        extrapolateBox.type = 'checkbox';
        extrapolateBox.className = 'curve-fit-extrapolate-box';
        extrapolateBox.checked = !!state.extrapolate;
        extrapolateBox.addEventListener('change', () => {
            state.extrapolate = extrapolateBox.checked;
            this._replaceCurveFitTraces(plot, plot._curveFitResults || []);
        });
        const extrapolateText = document.createElement('span');
        extrapolateText.textContent = i18n.t('curveFitExtrapolate');
        extrapolateLabel.append(extrapolateBox, extrapolateText);
        drawer.appendChild(extrapolateLabel);

        // 5) Unit of t′
        const info = this._curveFitTimeInfo(plot, trace);
        if (usesCalendar) {
            const unitSelect = document.createElement('select');
            unitSelect.className = 'phase2d-fit-type-select curve-fit-unit-select';
            unitSelect.title = i18n.t('curveFitTimeUnitTip');
            for (const unit of Object.keys(CURVE_FIT_TIME_UNITS)) {
                const option = document.createElement('option');
                option.value = unit;
                option.textContent = unit;
                option.selected = unit === state.timeUnit;
                unitSelect.appendChild(option);
            }
            unitSelect.addEventListener('change', () => {
                state.timeUnit = unitSelect.value;
                this._scheduleCurveFitRecompute(panelId, { immediate: true });
            });
            drawer.appendChild(field('curveFitTimeUnit', unitSelect));
        }

        // 6) Result
        if (entry.model === 'none') {
            const hint = document.createElement('p');
            hint.className = 'phase2d-fit-empty';
            hint.textContent = i18n.t('curveFitSelectModel');
            drawer.appendChild(hint);
            return;
        }
        const head = document.createElement('div');
        head.className = 'phase2d-fit-results-head';
        const title = document.createElement('h3');
        title.className = 'phase2d-fit-drawer-title';
        title.textContent = i18n.t('phase2dFitResultsTitle');
        // What the block below says, as text: the signal, the model in t′,
        // where t′ starts, the coefficients with their units and the fit.
        const copyLines = [];
        const copyBtn = createCopyButton(() => copyLines.join('\n'), { className: 'curve-fit-copy-btn' });
        head.append(title, helpButton('phase2dFitMetricsHelpTitle', () => this._showPhase2dFitMetricsHelp?.()), copyBtn);
        drawer.appendChild(head);

        const r = results.find(candidate => candidate.entry === entry) || { entry };
        const block = document.createElement('div');
        block.className = 'phase2d-fit-result';
        const fit = r.result?.fit;
        if (fit?.status === 'ok') {
            const unit = r.result.unit || '';
            const parts = fitEquationParts(fit, 't′');
            const eq = document.createElement('div');
            eq.className = 'phase2d-fit-equation';
            eq.textContent = parts.generic;
            block.appendChild(eq);
            copyLines.push(
                ...(trace ? [this._traceName(trace.varName, trace.fileId, { units: false })] : []),
                parts.generic,
                `t′ = t − t₀${unit ? ` [${unit}]` : ''}`,
            );
            const origin = document.createElement('div');
            origin.className = 'curve-fit-origin';
            origin.textContent = `t′ = t − t₀${unit ? ` [${unit}]` : ''}`;
            origin.title = i18n.t('curveFitTimeOrigin');
            block.appendChild(origin);
            const coeffs = document.createElement('div');
            coeffs.className = 'phase2d-fit-coeffs';
            const rows = [['t₀', this._curveFitFormatTime(trace, r.result.t0)], ...parts.coeffs];
            const rateNames = new Set(['α', 'b']);
            for (const [k, v] of rows) {
                const row = document.createElement('div');
                row.className = 'phase2d-fit-coeff';
                const kEl = document.createElement('span');
                kEl.className = 'phase2d-fit-coeff-k';
                kEl.textContent = k;
                const vEl = document.createElement('span');
                vEl.className = 'phase2d-fit-coeff-v';
                let suffix = '';
                const isRate = rateNames.has(k) && (fit.model.startsWith('exponential') || fit.model.startsWith('first-order'));
                if (unit && isRate) suffix = ` 1/${unit}`;
                if (unit && k === 'τ') suffix = ` ${unit}`;
                vEl.textContent = `= ${v}${suffix}`;
                row.append(kEl, vEl);
                coeffs.appendChild(row);
                copyLines.push(`${k} = ${v}${suffix}`);
            }
            block.appendChild(coeffs);
            const stats = document.createElement('dl');
            stats.className = 'phase2d-fit-stats';
            const fmt = (v) => (Number.isFinite(v) ? v.toPrecision(4) : 'N/A');
            const logLog = fit.model === 'power';
            const statRows = [];
            if (fit.model === 'linear' || logLog) statRows.push([i18n.t(logLog ? 'phase2dFitPearsonRLog' : 'phase2dFitPearsonR'), fmt(fit.r)]);
            statRows.push([i18n.t(logLog ? 'phase2dFitRSquaredLog' : 'phase2dFitRSquared'), fmt(fit.r2)]);
            statRows.push([i18n.t(logLog ? 'phase2dFitRmseLog' : 'phase2dFitRmse'), fmt(fit.rmse)]);
            statRows.push([i18n.t('phase2dFitN'), `${fit.n}${fit.nExcluded ? ` (−${fit.nExcluded})` : ''}`]);
            for (const [k, v] of statRows) {
                const dt = document.createElement('dt'); dt.textContent = k;
                const dd = document.createElement('dd'); dd.textContent = v;
                stats.append(dt, dd);
                copyLines.push(`${k}: ${v}`);
            }
            block.appendChild(stats);
            block.appendChild(this._curveFitSaveControls(panelId, plot, entry));
        }
        // Not fitted yet, or the fit failed: nothing worth copying.
        copyBtn.disabled = !copyLines.length;
        const warning = this._curveFitWarningText(r);
        if (warning) {
            const w = document.createElement('div');
            w.className = 'phase2d-fit-warning';
            w.setAttribute('role', 'alert');
            w.textContent = warning;
            block.appendChild(w);
        }
        drawer.appendChild(block);
    };

    // "Save fit as a signal": the fitted curve or the residual, NaN outside the
    // range unless Extrapolate (under the range) is ticked.
    proto._curveFitSaveControls = function(panelId, plot, entry) {
        const wrap = document.createElement('div');
        wrap.className = 'curve-fit-save';
        const title = document.createElement('div');
        title.className = 'phase2d-fit-field-label curve-fit-save-title';
        title.textContent = i18n.t('curveFitSaveTitle');
        const buttons = document.createElement('div');
        buttons.className = 'curve-fit-save-buttons';
        const make = (labelKey, tipKey, kind) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `fft-tool-btn curve-fit-save-${kind}`;
            button.textContent = i18n.t(labelKey);
            button.title = i18n.t(tipKey);
            button.addEventListener('click', () => this._saveCurveFitSignal(panelId, kind));
            return button;
        };
        buttons.append(
            make('curveFitSaveFit', 'curveFitSaveFitTip', 'fit'),
            make('curveFitSaveResidual', 'curveFitSaveResidualTip', 'residual'),
        );
        wrap.append(title, buttons);
        const message = plot._curveFitSignalMessage;
        if (message && message.fitId === entry?.id) {
            const line = document.createElement('div');
            line.className = `curve-fit-save-message curve-fit-save-${message.type}`;
            line.setAttribute('role', 'status');
            line.textContent = message.text;
            wrap.appendChild(line);
        }
        return wrap;
    };

    // Refresh the Start/End inputs from the active fit without stealing focus.
    proto._syncCurveFitRangeInputs = function(plot) {
        const drawer = plot?.curveFitOptionsEl;
        const entry = this._curveFitActiveEntry(plot);
        if (!drawer || !entry) return;
        const trace = this._curveFitTraceFor(plot, entry);
        const usesCalendar = !!trace && this._fftTimeKind(trace.fileId) === 'datetime';
        const [lo, hi] = this._curveFitRange(plot, entry);
        for (const [key, value] of [['x1', lo], ['x2', hi]]) {
            const input = drawer.querySelector(`.fft-number-input[data-curve-fit-key="${key}"]`);
            if (input && document.activeElement !== input) {
                input.value = usesCalendar ? msToDatetimeInput(value) : formatInputValue(value);
            }
        }
    };

    // ── Saving a fit as a signal ──────────────────────────────────
    // The active fit's curve (or its residual) becomes a formula variable of
    // the signal's file: listed in the sidebar, usable in any panel and in
    // formulas, saved with the view. The formula is written over the file's
    // own time column, so it is recomputed — the same numbers — on reload and
    // over a lazy file in SQL. Outside the fit's range it is NaN unless the
    // drawer's Extrapolate box is ticked.
    proto._curveFitSignalFormula = function(plot, r, kind) {
        const state = this._ensureCurveFitState(plot);
        const trace = r.trace;
        const data = this.files.get(trace.fileId)?.data;
        const timeEntry = Object.entries(data?.variables || {}).find(([, v]) => v?.kind === 'abscissa');
        if (!timeEntry) throw new Error('no-time');
        const range = this._curveFitRange(plot, r.entry);
        const timeVar = this._getTimeVar(trace.fileId);
        // The panel's times are the file's stored times after its transform
        // (time shift, a generated axis' step); map the range back to them.
        const source = this._sourceRangeForDisplayRange(trace.fileId, range, timeVar) || range;
        const span = range[1] - range[0];
        const sourceSpan = source[1] - source[0];
        const k = span > 0 && sourceSpan > 0 ? span / sourceSpan : 1;
        const transform = this._fileTransform(trace.fileId);
        return curveFitFormula(r.result.fit, {
            kind,
            signal: trace.varName,
            gain: Number(transform.gain),
            yOffset: Number(transform.yOffset),
            sign: this.isVariableSignInverted?.(trace.fileId, trace.varName) ? -1 : 1,
            extrapolate: !!state.extrapolate,
            time: {
                name: timeEntry[0],
                origin: source[0] + (r.result.t0 - range[0]) / k,
                divisor: r.result.scale / k,
                lo: source[0],
                hi: source[1],
            },
        });
    };

    proto._curveFitSignalName = function(plot, r, kind) {
        const variables = this.files.get(r.trace.fileId)?.data?.variables || {};
        const base = `${String(r.trace.varName).replace(/[^A-Za-z0-9_]+/g, '_')}_${kind === 'residual' ? 'res' : 'fit'}${r.index + 1}`;
        let name = base;
        for (let k = 2; variables[name]; k++) name = `${base}_${k}`;
        return name;
    };

    proto._saveCurveFitSignal = function(panelId, kind = 'fit') {
        const plot = this.plots.get(panelId);
        if (!plot) return null;
        const entry = this._curveFitActiveEntry(plot);
        const r = (plot._curveFitResults || []).find(candidate => candidate.entry === entry);
        const say = (text, type) => {
            plot._curveFitSignalMessage = { text, type, fitId: entry?.id };
            this._renderCurveFitDrawer(panelId, plot, plot._curveFitResults || []);
        };
        if (!r?.result?.fit || r.result.fit.status !== 'ok') {
            say(i18n.t('curveFitSaveNoFit'), 'error');
            return null;
        }
        if (typeof this.onCreateFormulaVariable !== 'function') return null;
        try {
            const formula = this._curveFitSignalFormula(plot, r, kind);
            const name = this._curveFitSignalName(plot, r, kind);
            const created = this.onCreateFormulaVariable(r.trace.fileId, name, formula);
            const key = created?.lazyOverviewOnly ? 'curveFitSavedOverviewOnly' : 'curveFitSaved';
            say(i18n.t(key).replace('{name}', name), created?.lazyOverviewOnly ? 'warning' : 'ok');
            return { name, formula };
        } catch (err) {
            const reason = err?.message === 'coefficient-overflow' ? i18n.t('fitCoefficientOverflow') : (err?.message || String(err));
            say(i18n.t('curveFitSaveFailed').replace('{reason}', reason), 'error');
            return null;
        }
    };

    // ── CSV export ────────────────────────────────────────────────
    proto._exportCurveFitCsv = async function(panelId, plot = this.plots.get(panelId), options = {}) {
        if (!plot || plot.mode !== 'curve-fit') return;
        const choice = await Modal.choice(i18n.t('phase2dFitCsvChooseMsg'), {
            title: i18n.t('phase2dFitCsvChooseTitle'),
            icon: false,
            choices: [
                { text: i18n.t('phase2dFitCsvSummary'), value: 'summary', className: 'modal-btn-confirm', autoFocus: true },
                { text: i18n.t('curveFitCsvCurve'), value: 'curve', className: 'modal-btn-cancel' },
            ],
        });
        if (!choice) return;
        const out = choice === 'summary' ? this._curveFitSummaryCsv(plot) : this._curveFitCurveCsv(plot);
        if (!out) return;
        const filename = options.baseName ? `${options.baseName}_${choice}.csv` : out.filename;
        this._downloadCsvColumns(out.headers, out.columns, filename);
    };

    proto._curveFitTimeCell = function(trace, value) {
        if (!Number.isFinite(value)) return '';
        if (trace && this._fftTimeKind(trace.fileId) === 'datetime') return new Date(value).toISOString();
        return value;
    };

    proto._curveFitSummaryCsv = function(plot) {
        const results = this._computeCurveFits(plot);
        if (!results.length) return null;
        const num = (v) => (Number.isFinite(v) ? v : '');
        const fitOf = (r, key) => (r.result?.fit?.status === 'ok' ? r.result.fit[key] : NaN);
        const fields = [
            ['fit', (r) => `F${r.index + 1}`],
            ['file', (r) => (r.trace ? (this.files.get(r.trace.fileId)?.name ?? r.trace.fileId ?? '') : '')],
            ['signal', (r) => (r.trace ? this._variableLabel(r.trace.varName, r.trace.fileId) : '')],
            ['signal_unit', (r) => (r.trace ? this._phase2dVarUnit?.(r.trace.fileId, r.trace.varName) ?? '' : '')],
            ['model', (r) => r.entry.model],
            ['range', (r) => (r.entry.rangeFull ? 'all' : 'selection')],
            ['range_start', (r) => this._curveFitTimeCell(r.trace, this._curveFitRange(plot, r.entry)[0])],
            ['range_end', (r) => this._curveFitTimeCell(r.trace, this._curveFitRange(plot, r.entry)[1])],
            ['t0', (r) => this._curveFitTimeCell(r.trace, r.result?.t0)],
            ['t_prime_unit', (r) => r.result?.unit ?? ''],
            ['n_scope', (r) => num(r.result?.nScope)],
            ['n_fit', (r) => num(fitOf(r, 'n'))],
            ['n_excluded', (r) => num(fitOf(r, 'nExcluded'))],
            ...FIT_CSV_COEFFICIENTS.map(([header, models, key]) => (
                [header, (r) => (fitCsvCoefficient(r.entry.model, models) ? num(fitOf(r, key)) : '')]
            )),
            ['pearson_r', (r) => (r.entry.model === 'linear' || r.entry.model === 'power' ? num(fitOf(r, 'r')) : '')],
            ['r_squared', (r) => num(fitOf(r, 'r2'))],
            ['rmse', (r) => num(fitOf(r, 'rmse'))],
            ['status', (r) => (r.entry.model === 'none' ? 'none' : (r.result?.fit?.status ?? (r.lazy ? r.lazyStatus || 'pending' : '')))],
            ['warning', (r) => r.result?.fit?.warning ?? ''],
        ];
        const headers = [];
        const columns = [];
        for (const [header, fn] of fields) {
            headers.push(header);
            columns.push(results.map(r => csvValueCell(fn(r))));
        }
        return { headers, columns, filename: 'curve_fit_summary.csv' };
    };

    proto._curveFitCurveCsv = function(plot) {
        const results = this._computeCurveFits(plot);
        const fitCol = [];
        const modelCol = [];
        const tCol = [];
        const tPrimeCol = [];
        const yCol = [];
        for (const r of results) {
            const curve = r.result?.curve;
            if (!curve?.t?.length) continue;
            for (let k = 0; k < curve.t.length; k++) {
                fitCol.push(`F${r.index + 1}`);
                modelCol.push(r.entry.model);
                tCol.push(csvValueCell(this._curveFitTimeCell(r.trace, curve.t[k])));
                tPrimeCol.push(curve.tPrime[k]);
                yCol.push(curve.y[k]);
            }
        }
        if (!fitCol.length) return null;
        return {
            headers: ['fit', 'model', 't', 't_prime', 'y_predicted'],
            columns: [fitCol, modelCol, tCol, tPrimeCol, yCol],
            filename: 'curve_fit_curve.csv',
        };
    };
}
