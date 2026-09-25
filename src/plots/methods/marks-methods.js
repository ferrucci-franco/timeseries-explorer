// The Marks menu and its two missing-data tools, NaN/Inf and Gaps
// (docs/marks-menu-nan-gaps-design.md).
//
// NaN/Inf is a property of a VALUE of one variable: exact, no assumption. It is
// drawn as a strip along the top (utils/nan-strip.js) so it never covers the
// other traces, and a trace's line is always broken across its own NaN runs.
// Gaps is a property of a file's TIME AXIS: it needs a nominal step Δt and a
// threshold, which the user can see and set in the Gaps panel. Its bands are
// full height — a gap has no rows of that file, so the band hides nothing.
//
// The FFT pane is not touched by any of this: it keeps _missingDataInfo and the
// classic detector (fft-methods.js), which its uniformity checks rely on.
import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';
import {
    GAP_DEFAULT_FACTOR,
    GAP_STEP_MIN_AGREEMENT,
    detectGapIndices,
    estimateNominalStep,
    nanRunIndices,
    nominalStepFromHistogram,
} from '../../utils/sampling-gaps.js';
import {
    NAN_STRIP_HEIGHT_PX,
    NAN_STRIP_LEVEL_ALPHA,
    gapIntervalsInRange,
    isNonDecreasing,
    nanBreakIntervals,
    nanStripForView,
    nanStripFromBuckets,
} from '../../utils/nan-strip.js';
import { lazyGapsFromBuckets } from '../../data/missing-buckets-sql.js';
import { TIME_UNITS, formatTimeValue, pickTimeUnit } from '../../utils/time-unit-format.js';

// Above this many gaps (or NaN runs) in view, the per-item intervals are not
// materialized at all: they would be coalesced into a wall anyway, and a wrong
// manual Δt can make every step of a multi-million-row file a "gap".
const MAX_ITEMS_IN_VIEW = 200000;
// Four-arrow "move" glyph, identical to the cursor readout's header icon.
const MOVE_ICON_SVG = '<svg class="cursor-info-move-icon" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M13 6V11H18V7.75L22.25 12L18 16.25V13H13V18H16.25L12 22.25L7.75 18H11V13H6V16.25L1.75 12L6 7.75V11H11V6H7.75L12 1.75L16.25 6H13Z"/></svg>';
// Pixel height of the Repeated strip's slot (paper 0.985–1 of the plot area) is
// read from the laid-out plot; this is the fallback before layout.
const REPEATED_STRIP_FRACTION = 0.015;

export function installPlotMarksMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // ── Per-array caches ──
    // Keyed by the array itself (a WeakMap), so a reload, a live append or a
    // transform — all of which hand out a new array — is scanned again and
    // never served stale results.
    const memo = (self, name, key, compute) => {
        if (!key || typeof key !== 'object') return compute();
        if (!self._marksMemo) self._marksMemo = new Map();
        let map = self._marksMemo.get(name);
        if (!map) { map = new WeakMap(); self._marksMemo.set(name, map); }
        const hit = map.get(key);
        if (hit && hit.length === key.length) return hit.value;
        const value = compute();
        map.set(key, { length: key.length, value });
        return value;
    };

    proto._nanRunsFor = function(values) {
        return memo(this, 'nanRuns', values, () => nanRunIndices(values));
    };

    proto._timesMonotonic = function(times) {
        return memo(this, 'monotonic', times, () => isNonDecreasing(times));
    };

    proto._isLazyViewFile = function(fileId) {
        return !!this.files.get(fileId)?.data?._duckdb?.viewMode;
    };

    // ── Gap settings (per file) ──

    // `{ dt, factor }` with `dt` in DISPLAY time units (what the eager time
    // vector and the plot axis hold); `dt: null` = automatic. Stored with the
    // unit it was set in (`unit`: seconds per display unit, 0 for a row index),
    // so a manual step survives the axis being shown another way (calendar ms
    // ↔ elapsed seconds) — and is dropped, back to automatic, when the axis
    // turns into a row count, where a time step means nothing.
    proto._gapSettings = function(fileId) {
        const saved = this.files.get(fileId)?.gapSettings || {};
        let dt = Number(saved.dt);
        const factor = Number(saved.factor);
        const savedUnit = Number(saved.unit);
        if (Number.isFinite(dt) && dt > 0 && Number.isFinite(savedUnit)) {
            const { secondsPerUnit, unitless } = this._gapAxisScale(fileId);
            const unit = unitless ? 0 : secondsPerUnit;
            if (unit !== savedUnit) dt = unit > 0 && savedUnit > 0 ? (dt * savedUnit) / unit : NaN;
        }
        return {
            dt: Number.isFinite(dt) && dt > 0 ? dt : null,
            factor: Number.isFinite(factor) && factor > 1 ? factor : GAP_DEFAULT_FACTOR,
        };
    };

    proto._setGapSettings = function(fileId, patch = {}) {
        const entry = this.files.get(fileId);
        if (!entry) return;
        const next = { ...this._gapSettings(fileId), ...patch };
        const dt = Number(next.dt);
        const factor = Number(next.factor);
        const { secondsPerUnit, unitless } = this._gapAxisScale(fileId);
        entry.gapSettings = {
            dt: Number.isFinite(dt) && dt > 0 ? dt : null,
            factor: Number.isFinite(factor) && factor > 1 ? factor : GAP_DEFAULT_FACTOR,
            unit: unitless ? 0 : secondsPerUnit,
        };
        entry._gapSummary = null;
        // Every panel showing the file redraws: Δt is the file's, not the panel's.
        for (const [panelId, plot] of this.plots) {
            if (plot.mode !== 'timeseries' || !plot.showGaps) continue;
            if (!plot.traces.some(t => t.fileId === fileId)) continue;
            plot._lazyMarksSig = null;
            this._refreshTimeseriesVisuals(panelId, plot);
            this._renderGapsPanel(panelId);
        }
    };

    // How the display time of a file is measured: seconds per display unit, or
    // unitless for a pure row index. Mirrors the inspector's reading of the
    // canonical model (_transformedTimeAxisScale).
    proto._gapAxisScale = function(fileId) {
        const model = this._timeAxisModel?.(fileId);
        if (!model) return { secondsPerUnit: 1, unitless: false };
        if (model.semantic === 'count') return { secondsPerUnit: 1, unitless: true };
        if (model.display === 'calendar' && !model.highResGeneratedCalendar) {
            return { secondsPerUnit: 1e-3, unitless: false };
        }
        return { secondsPerUnit: 1, unitless: false };
    };

    // A step in display units, as a person reads it ("1 s", "10 min", "3").
    // Four significant digits: a jittered 1 s logger reads "1 s", not
    // "1.00002 s" (the Δt field keeps the full value).
    proto._formatGapStep = function(fileId, dt) {
        if (!Number.isFinite(dt)) return '—';
        const { secondsPerUnit, unitless } = this._gapAxisScale(fileId);
        const rounded = (value) => Number(value.toPrecision(4));
        if (unitless) return String(rounded(dt));
        const seconds = dt * secondsPerUnit;
        const unit = pickTimeUnit([seconds]);
        return formatTimeValue(rounded(seconds / unit.factor) * unit.factor, unit);
    };

    // Display units per source unit, for a lazy file (whose SQL runs on source
    // time). Affine axes only — which is what every time transform here is.
    proto._lazyDisplayScale = function(fileId) {
        const data = this.files.get(fileId)?.data;
        const start = Number(data?.metadata?.timeStart);
        const end = Number(data?.metadata?.timeEnd);
        const timeVar = this._getTimeVar(fileId);
        const a = Number.isFinite(start) ? start : 0;
        const span = Number.isFinite(end) && end > a ? end - a : 1;
        const d0 = this._displayTimeForFetchedSourceTime(fileId, a, 0, timeVar);
        const d1 = this._displayTimeForFetchedSourceTime(fileId, a + span, null, timeVar);
        const scale = (d1 - d0) / span;
        return Number.isFinite(scale) && scale > 0 ? scale : 1;
    };

    // The automatic step of a file, display units:
    //   { dt, agreement, monotonic, pending }
    // Eager: the mode of the steps of the (transformed) time vector, cached per
    // array. Lazy: the same estimate from a DuckDB step histogram, queried once
    // per data object; `pending` until it arrives (the caller redraws then).
    proto._autoGapStep = function(fileId, varName = null) {
        const data = this.files.get(fileId)?.data;
        if (!data) return { dt: NaN, agreement: NaN, monotonic: true, pending: false };
        if (data._duckdb?.viewMode) {
            const estimate = data._gapStepEstimate;
            if (estimate?.status === 'ready') {
                const scale = this._lazyDisplayScale(fileId);
                return { dt: estimate.dt * scale, agreement: estimate.agreement, monotonic: true, pending: false };
            }
            if (estimate?.status === 'error') return { dt: NaN, agreement: NaN, monotonic: true, pending: false };
            this._requestLazyGapStep(fileId);
            return { dt: NaN, agreement: NaN, monotonic: true, pending: true };
        }
        const times = varName
            ? this._getTransformedTimeDataForVariable(fileId, varName)
            : this._getTransformedTimeData(fileId);
        const estimate = memo(this, 'autoStep', times, () => estimateNominalStep(times));
        return { ...estimate, pending: false };
    };

    proto._requestLazyGapStep = function(fileId) {
        const data = this.files.get(fileId)?.data;
        const source = data?._duckdb?.source;
        if (!source?.getStepHistogram || data._gapStepEstimate) return;
        const estimate = { status: 'pending' };
        data._gapStepEstimate = estimate;
        estimate.promise = source.getStepHistogram(data).then(({ bins, positive }) => {
            const result = nominalStepFromHistogram(bins, positive);
            Object.assign(estimate, { status: 'ready', dt: result.dt, agreement: result.agreement });
        }).catch(error => {
            console.warn('[gaps] step histogram failed:', error);
            estimate.status = 'error';
        }).then(() => {
            if (this.files.get(fileId)?.data !== data) return;
            for (const [panelId, plot] of this.plots) {
                if (plot.mode !== 'timeseries' || !plot.showGaps) continue;
                if (!plot.traces.some(t => t.fileId === fileId)) continue;
                plot._lazyMarksSig = null;
                this._refreshTimeseriesVisuals(panelId, plot);
                this._renderGapsPanel(panelId);
            }
        });
    };

    // The step the Gaps tool uses for a file: the manual one, or the automatic.
    proto._resolvedGapStep = function(fileId, varName = null) {
        const settings = this._gapSettings(fileId);
        const auto = this._autoGapStep(fileId, varName);
        const dt = settings.dt ?? auto.dt;
        return {
            dt,
            factor: settings.factor,
            manual: settings.dt !== null,
            auto,
            monotonic: auto.monotonic,
            pending: settings.dt === null && auto.pending,
        };
    };

    // ── Eager gaps ──

    // Per visible file: its gaps for the resolved step, as row indices (see
    // detectGapIndices). Memoized per time array + step + factor.
    proto._timeseriesGapFiles = function(plot) {
        const out = [];
        const seen = new Set();
        for (const t of plot?.traces || []) {
            if (!this._isVisible(t) || seen.has(t.fileId)) continue;
            seen.add(t.fileId);
            if (this._isLazyViewFile(t.fileId)) continue;
            const times = this._getTransformedTimeDataForVariable(t.fileId, t.varName);
            const step = this._resolvedGapStep(t.fileId, t.varName);
            const timeVar = this._getTimeVar(t.fileId);
            const key = `${step.dt}\u0000${step.factor}`;
            const gaps = memo(this, `gaps:${key}`, times, () => detectGapIndices(times, step.dt, step.factor));
            out.push({ fileId: t.fileId, timeVar, times, step, gaps });
        }
        return out;
    };

    // What the pill should say about a file's step, if anything: unsorted
    // timestamps outrank a weak agreement.
    proto._gapsStepNotice = function(plot) {
        const files = new Set();
        for (const t of plot?.traces || []) if (this._isVisible(t)) files.add(t.fileId);
        let irregular = null;
        for (const fileId of files) {
            const step = this._resolvedGapStep(fileId);
            if (!step.monotonic) return { mode: 'unsorted', label: i18n.t('timeseriesGapsUnsorted') };
            const agreement = step.auto.agreement;
            if (!step.manual && Number.isFinite(agreement) && agreement < GAP_STEP_MIN_AGREEMENT && !irregular) {
                irregular = { fileId, agreement, dt: step.dt };
            }
        }
        if (!irregular) return null;
        return {
            mode: 'irregular',
            label: i18n.t('timeseriesGapsIrregular')
                .replace('{percent}', String(Math.round(irregular.agreement * 100)))
                .replace('{dt}', this._formatGapStep(irregular.fileId, irregular.dt)),
        };
    };

    // Visible range and plot width, in display units, or null before layout.
    proto._marksView = function(plot) {
        const xa = plot?.div?._fullLayout?.xaxis;
        if (!xa || !Array.isArray(xa.range) || !(xa._length > 0)) return null;
        let lo = this._coerceAxisValue(xa.range[0]);
        let hi = this._coerceAxisValue(xa.range[1]);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
        if (lo > hi) [lo, hi] = [hi, lo];
        return { lo, hi, width: xa._length };
    };

    // Gap bands for the current view (eager files) + the lazy cache.
    proto._gapBandItemsForView = function(plot, view) {
        const items = [];
        let overflow = false;
        for (const file of this._timeseriesGapFiles(plot)) {
            if (!file.gaps.count) continue;
            const spans = gapIntervalsInRange(file.times, file.gaps.ends,
                view ? view.lo : -Infinity, view ? view.hi : Infinity, MAX_ITEMS_IN_VIEW);
            if (!spans) { overflow = true; continue; }
            for (const s of spans) items.push({ fileId: file.fileId, timeVar: file.timeVar, t0: s.t0, t1: s.t1 });
        }
        return { items, overflow };
    };

    // ── Line breaks ──

    // Where one trace's line must not be drawn straight across, for [lo, hi]:
    // its own NaN runs (always) and its file's gaps (while Gaps is on). A kind
    // denser than half the pixels is skipped — the breaks would shred the
    // downsampled envelope into invisible fragments. Eager traces only; null
    // means "no breaks".
    proto._traceBreakIntervals = function(plot, t, lo = -Infinity, hi = Infinity, widthPx = null) {
        // A stacked panel draws cumulative areas, which a NaN point would tear
        // open for every trace above it.
        if (!t || plot?.timeseriesStacked || this._isLazyViewFile(t.fileId)) return null;
        const variable = this.files.get(t.fileId)?.data?.variables?.[t.varName];
        if (!variable || variable.kind === 'parameter') return null;
        const times = this._getTransformedTimeDataForVariable(t.fileId, t.varName);
        if (!times?.length || !this._timesMonotonic(times)) return null;
        const width = widthPx || plot?.div?._fullLayout?.xaxis?._length || plot?.div?.clientWidth || 1000;
        const limit = Math.max(1, Math.floor(width * 0.5));
        const out = [];
        const values = this._getTransformedVariableData(t.fileId, t.varName);
        const runs = this._nanRunsFor(values);
        if (runs.count) {
            const nan = nanBreakIntervals(times, runs, lo, hi, limit);
            if (nan) out.push(...nan);
        }
        if (plot?.showGaps) {
            const step = this._resolvedGapStep(t.fileId, t.varName);
            const key = `${step.dt}\u0000${step.factor}`;
            const gaps = memo(this, `gaps:${key}`, times, () => detectGapIndices(times, step.dt, step.factor));
            if (gaps.count) {
                const spans = gapIntervalsInRange(times, gaps.ends, lo, hi, limit);
                if (spans) out.push(...spans);
            }
        }
        if (!out.length) return null;
        out.sort((a, b) => a.t0 - b.t0);
        return out;
    };

    // ── NaN/Inf strip ──

    proto._nanStripColor = function(alpha) {
        return this.theme === 'dark' ? `rgba(179, 136, 255, ${alpha})` : `rgba(126, 87, 194, ${alpha})`;
    };

    // Pixel offset of the strip from the top of the plot area: under the
    // Repeated strip while Repeated is on, else flush with the top.
    proto._nanStripOffsetPx = function(plot) {
        if (!plot?.showRepeated) return 0;
        const h = plot.div?._fullLayout?._size?.h;
        return Math.ceil((Number(h) > 0 ? h : 300) * REPEATED_STRIP_FRACTION) + 1;
    };

    // Regions for the current view: eager traces here, lazy ones from the cache
    // the DuckDB bucket query filled.
    proto._nanStripRegions = function(plot, view) {
        const sources = [];
        const names = new Map();
        let anchor = null;
        for (const t of plot?.traces || []) {
            if (!this._isVisible(t) || this._isLazyViewFile(t.fileId)) continue;
            const variable = this.files.get(t.fileId)?.data?.variables?.[t.varName];
            if (!variable || variable.kind === 'parameter') continue;
            const values = this._getTransformedVariableData(t.fileId, t.varName);
            const runs = this._nanRunsFor(values);
            if (!runs.count) continue;
            const times = this._getTransformedTimeDataForVariable(t.fileId, t.varName);
            const key = this._missTraceKey(t);
            names.set(key, this._variableLabel?.(t.varName, t.fileId) || t.varName);
            sources.push({ key, times, values, runs, monotonic: this._timesMonotonic(times) });
            anchor ||= t;
        }
        const regions = [];
        if (sources.length) {
            for (const region of nanStripForView(sources, view.lo, view.hi, view.width).regions) {
                regions.push({ ...region, fileId: anchor.fileId, timeVar: this._getTimeVar(anchor.fileId) });
            }
        }
        for (const region of plot._lazyNanRegions || []) regions.push(region);
        return { regions, names };
    };

    proto._nanStripHoverText = function(region, names) {
        const line = (nan, total) => i18n.t('timeseriesNaNHover')
            .replace('{nan}', String(nan))
            .replace('{total}', String(total))
            .replace('{percent}', String(total > 0 ? Math.round((nan / total) * 1000) / 10 : 0));
        if (!region.perKey) return line(region.nan || 0, region.total || 0);
        const entries = Object.entries(region.perKey).filter(([, c]) => c.nan > 0);
        if (entries.length === 1 && names.size <= 1) return line(entries[0][1].nan, entries[0][1].total);
        return entries.map(([key, c]) => `${this._escapeHTML(names.get(key) || key)}: ${line(c.nan, c.total)}`).join('<br>');
    };

    proto._nanStripOverlay = function(plot) {
        const view = this._marksView(plot);
        if (!view) return { shapes: [], hover: [] };
        const { regions, names } = this._nanStripRegions(plot, view);
        const offset = this._nanStripOffsetPx(plot);
        const shapes = [];
        const hover = [];
        for (const region of regions) {
            if (region.t1 < view.lo || region.t0 > view.hi) continue;
            const alpha = NAN_STRIP_LEVEL_ALPHA[region.level] || NAN_STRIP_LEVEL_ALPHA[1];
            const x0 = this._plotlyTimeValue(region.fileId, region.t0, region.timeVar);
            const x1 = this._plotlyTimeValue(region.fileId, region.t1, region.timeVar);
            shapes.push({
                type: 'rect', xref: 'x', yref: 'paper',
                ysizemode: 'pixel', yanchor: 1,
                x0, x1,
                y0: -(offset + NAN_STRIP_HEIGHT_PX), y1: offset ? -offset : 0,
                fillcolor: this._nanStripColor(alpha),
                line: { width: 0 },
                layer: 'above',
            });
            hover.push({ t0: region.t0, t1: region.t1, x0, x1, text: this._nanStripHoverText(region, names) });
        }
        return { shapes, hover, offset };
    };

    // Hover over the strip: Plotly gives shapes none, so a small label of our
    // own follows the pointer, as for the Repeated bars. Installed once per div.
    proto._ensureNanStripHover = function(plot) {
        const div = plot?.div;
        if (!div || div._nanStripHoverInstalled) return;
        div._nanStripHoverInstalled = true;
        let label = null;
        const hide = () => { if (label) label.style.display = 'none'; };
        div.addEventListener('mouseleave', hide);
        div.addEventListener('mousemove', (event) => {
            const marks = plot.showNaN ? plot._nanStripHover : null;
            const layout = div._fullLayout;
            const xa = layout?.xaxis;
            if (!marks?.length || !xa || !layout._size) return hide();
            const rect = div.getBoundingClientRect();
            const px = event.clientX - rect.left;
            const py = event.clientY - rect.top;
            const top = layout._size.t + (plot._nanStripOffset || 0);
            if (py < top - 2 || py > top + NAN_STRIP_HEIGHT_PX + 2) return hide();
            const toPx = (x) => xa._offset + xa.l2p(xa.d2l(x));
            const hit = marks.find(m => {
                const a = toPx(m.x0);
                const b = toPx(m.x1);
                return px >= Math.min(a, b) - 2 && px <= Math.max(a, b) + 2;
            });
            if (!hit) return hide();
            if (!label) {
                label = document.createElement('div');
                label.className = 'repeated-hover-label nan-strip-hover-label';
                document.body.appendChild(label);
            }
            label.innerHTML = hit.text;
            label.style.borderColor = this._nanStripColor(1);
            label.style.left = `${event.clientX + 12}px`;
            label.style.top = `${event.clientY + 12}px`;
            label.style.display = 'block';
        });
    };

    // ── Putting it together ──

    // Recompute the NaN strip and the gap bands for the current view and cache
    // their shapes on the plot. Returns the pill state for the Gaps notice.
    proto._updateTimeseriesMarks = function(plot) {
        plot._nanShapes = [];
        plot._nanStripHover = [];
        plot._gapShapes = [];
        if (plot?.mode !== 'timeseries' || !plot.div) return false;
        if (plot.showNaN) {
            const overlay = this._nanStripOverlay(plot);
            plot._nanShapes = overlay.shapes;
            plot._nanStripHover = overlay.hover;
            plot._nanStripOffset = overlay.offset || 0;
            this._ensureNanStripHover(plot);
        }
        if (!plot.showGaps) return false;
        const view = this._marksView(plot);
        const { items, overflow } = this._gapBandItemsForView(plot, view);
        const lazyItems = plot._lazyGapItems || [];
        const all = lazyItems.length ? [...items, ...lazyItems] : items;
        const dense = overflow || this._missingViewIsDense(plot, all);
        plot._gapShapes = overflow && !all.length ? [] : this._adaptiveGapBandShapes(plot, all, dense);
        return dense;
    };

    // Everything the time-series overlays put in layout.shapes, in draw order.
    proto._timeseriesOverlayShapes = function(plot) {
        if (plot?.mode !== 'timeseries') return [];
        return [
            ...(plot.showGaps ? (plot._gapShapes || []) : []),
            ...(plot.showNaN ? (plot._nanShapes || []) : []),
            ...(plot.showRepeated ? (plot._repeatedShapes || []) : []),
        ];
    };

    proto._refreshGapsNotice = function(plot, dense) {
        if (!plot?.showGaps || plot.mode !== 'timeseries') {
            this._setMissingDensityNotice(plot, false);
            return;
        }
        this._setMissingDensityNotice(plot, this._gapsStepNotice(plot) || (dense ? 'dense' : false));
    };

    // ── Lazy (DuckDB) files ──

    // One bucket query per lazy file over the visible range (the same query the
    // FFT pane uses), reduced to the NaN strip and — for the file's own Δt, not
    // a per-viewport estimate — the gap bands. Token-guarded, latest wins.
    proto._refreshLazyTimeseriesMarks = function(panelId, plot, t0, t1, token) {
        const active = plot?.div && plot.mode === 'timeseries' && (plot.showNaN || plot.showGaps);
        if (!active) {
            this._cancelLazyMissingRequest(panelId);
            if (plot) { plot._lazyNanRegions = []; plot._lazyGapItems = []; }
            return Promise.resolve([]);
        }
        this._cancelLazyMissingRequest(panelId);

        const perFile = new Map();
        for (const t of plot.traces) {
            if (!this._isVisible(t)) continue;
            const data = this.files.get(t.fileId)?.data;
            const source = data?._duckdb?.source;
            if (!source?.getMissingIntervals || !data._duckdb.viewMode) continue;
            let entry = perFile.get(t.fileId);
            if (!entry) {
                entry = { data, source, timeVar: this._getTimeVar(t.fileId), varNames: new Set() };
                perFile.set(t.fileId, entry);
            }
            entry.varNames.add(t.varName);
        }
        const paint = () => {
            if (!plot.div) return;
            const dense = this._updateTimeseriesMarks(plot);
            Plotly.relayout(plot.div, { shapes: this._timeseriesOverlayShapes(plot) });
            this._refreshGapsNotice(plot, dense || !!plot._lazyGapDense);
        };
        if (!perFile.size) {
            plot._lazyNanRegions = [];
            plot._lazyGapItems = [];
            plot._lazyGapDense = false;
            paint();
            return Promise.resolve([]);
        }

        const xa = plot.div._fullLayout?.xaxis;
        const pxWidth = Math.max(50, Math.min(2000, Math.round(xa?._length || 1500)));
        const steps = [...perFile.keys()].map(fileId => {
            const step = this._resolvedGapStep(fileId);
            return `${fileId}:${step.dt}:${step.factor}`;
        }).join('|');
        const sig = [
            pxWidth, Math.round(t0), Math.round(t1), plot.showNaN ? 1 : 0, plot.showGaps ? 1 : 0, steps,
            [...perFile.entries()].map(([fid, e]) => `${fid}:${[...e.varNames].sort().join(',')}`).join('|'),
        ].join('\u0001');
        if (plot._lazyMarksSig === sig) {
            paint();
            return Promise.resolve([]);
        }
        this._setMissingDensityNotice(plot, 'loading');
        const controller = new AbortController();
        const request = { controller, token, plot };
        if (!this._lazyMissingRequests) this._lazyMissingRequests = new Map();
        this._lazyMissingRequests.set(panelId, request);

        const settled = Promise.all([...perFile.entries()].map(([fileId, entry]) => {
            const src = this._sourceRangeForDisplayRange(fileId, [t0, t1], entry.timeVar);
            if (!src || !src.every(Number.isFinite)) return null;
            const sourceLo = Math.min(src[0], src[1]);
            const sourceHi = Math.max(src[0], src[1]);
            if (!(sourceHi > sourceLo)) return null;
            const nBuckets = this._lazyMissingBucketCount(entry.data, sourceLo, sourceHi, pxWidth);
            const mapTime = value => this._displayTimeForFetchedSourceTime(fileId, value, null, entry.timeVar);
            return entry.source.getMissingIntervals(
                entry.data, [...entry.varNames], sourceLo, sourceHi, nBuckets, { signal: controller.signal },
            ).then(({ buckets }) => {
                const span = sourceHi - sourceLo;
                const nan = nanStripFromBuckets(buckets, nBuckets, i => mapTime(sourceLo + (i / nBuckets) * span))
                    .map(region => ({ ...region, fileId, timeVar: entry.timeVar }));
                const step = this._resolvedGapStep(fileId);
                const scale = this._lazyDisplayScale(fileId);
                const gaps = plot.showGaps && Number.isFinite(step.dt)
                    ? lazyGapsFromBuckets(buckets, {
                        t0: sourceLo, t1: sourceHi, nBuckets,
                        nominalStep: step.dt / scale, factor: step.factor,
                        fileId, timeVar: entry.timeVar, mapTime,
                    })
                    : [];
                return { nan, gaps };
            }).catch(err => {
                if (err?.name === 'AbortError') throw err;
                console.warn('[marks] lazy query failed:', err);
                return null;
            });
        })).then(results => {
            if (this._lazyMissingRequests?.get(panelId) !== request
                || this._zoomTokens?.get(panelId) !== token
                || !plot.div || plot.mode !== 'timeseries') return [];
            plot._lazyNanRegions = results.flatMap(r => r?.nan || []);
            plot._lazyGapItems = results.flatMap(r => r?.gaps || []);
            plot._lazyGapDense = false;
            plot._lazyMarksSig = sig;
            paint();
            return plot._lazyGapItems;
        }).catch(err => {
            if (err?.name !== 'AbortError') console.warn('[marks] lazy refresh failed:', err);
            if (this._lazyMissingRequests?.get(panelId) === request
                && this._zoomTokens?.get(panelId) === token) {
                this._setMissingDensityNotice(plot, false);
            }
            return [];
        }).finally(() => {
            if (this._lazyMissingRequests?.get(panelId) === request) this._lazyMissingRequests.delete(panelId);
        });
        request.promise = settled;
        this._lastLazyMissingRefresh = settled;
        return settled;
    };

    // ── Toggles ──

    const syncAfterToggle = (self, panelId, plot, capturedView) => {
        if (plot.div) self._rebuildPanel(panelId, { restoreView: capturedView });
        else self._refreshActionBtns(panelId);
        self._syncMarksControls(panelId);
    };

    proto._toggleNaN = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'timeseries') return;
        const capturedView = plot.div ? this._capturePlotView(plot) : null;
        plot.showNaN = !plot.showNaN;
        plot._lazyMarksSig = null;
        if (!plot.showNaN) {
            plot._nanShapes = [];
            plot._nanStripHover = [];
            plot._lazyNanRegions = [];
        }
        syncAfterToggle(this, panelId, plot, capturedView);
    };

    proto._toggleGaps = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'timeseries') return;
        const capturedView = plot.div ? this._capturePlotView(plot) : null;
        plot.showGaps = !plot.showGaps;
        plot._lazyMarksSig = null;
        if (!plot.showGaps) {
            plot._gapShapes = [];
            plot._lazyGapItems = [];
            this._setMissingDensityNotice(plot, false);
            this._closeGapsPanel(panelId);
        }
        syncAfterToggle(this, panelId, plot, capturedView);
        // The first time in a panel, the settings open by themselves, already
        // filled in — the bands are drawn behind them.
        if (plot.showGaps && !plot._gapsPanelShown) {
            plot._gapsPanelShown = true;
            // The panel takes over from the menu (and the keyboard focus).
            this._closeMarksMenu();
            this._openGapsPanel(panelId);
        }
    };

    // Panel-level line shape: 'auto' clears every per-trace override (each
    // trace follows its variable), 'linear' / 'hv' sets it on every trace.
    proto._panelLineShapeState = function(plot) {
        const traces = plot?.traces || [];
        if (!traces.length) return 'auto';
        const shapes = new Set(traces.map(t => t.lineShape || 'auto'));
        return shapes.size === 1 ? [...shapes][0] : 'mixed';
    };

    proto._setPanelLineShape = function(panelId, shape) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'timeseries') return;
        for (const trace of plot.traces) {
            if (shape === 'auto') delete trace.lineShape;
            else trace.lineShape = shape === 'hv' ? 'hv' : 'linear';
        }
        if (plot.div) this._rebuildPanel(panelId, { preserveView: true });
        this._syncMarksControls(panelId);
    };

    // ── Marks menu ──

    // The items, from the plot state. `run` is what a click does. Marks are
    // what is drawn ON the data; how the axes read it is the View menu's.
    proto._marksMenuModel = function(panelId, plot) {
        const has = this._hasContent?.(plot) && plot?.mode === 'timeseries';
        const repeatedAvailability = has ? this._repeatedAvailability(plot) : 'some';
        const samplesWaiting = plot?.showSamples ? plot._samplesWaiting : null;
        const repeatedWaiting = plot?.showRepeated && repeatedAvailability !== 'none'
            && (plot._repeatedWaiting === 'lazy' || repeatedAvailability === 'lazy');
        let repeatedTitle = 'timeseriesRepeatedToggle';
        if (has && repeatedAvailability === 'none') repeatedTitle = 'timeseriesRepeatedNone';
        else if (repeatedWaiting) repeatedTitle = 'timeseriesRepeatedLazy';
        return [
            { key: 'nan', label: 'timeseriesNaNLabel', title: 'timeseriesNaNToggle', checked: !!plot?.showNaN, disabled: !has, run: () => this._toggleNaN(panelId) },
            { key: 'gaps', label: 'timeseriesGapsLabel', title: 'timeseriesGapsToggle', checked: !!plot?.showGaps, disabled: !has, run: () => this._toggleGaps(panelId), settings: () => this._openGapsPanel(panelId) },
            { key: 'repeated', label: 'timeseriesRepeatedLabel', title: repeatedTitle, checked: !!plot?.showRepeated, disabled: !has || repeatedAvailability === 'none', waiting: !!repeatedWaiting, run: () => this._toggleRepeated(panelId) },
            { key: 'samples', label: 'timeseriesSamplesLabel', title: samplesWaiting ? (samplesWaiting === 'lazy' ? 'timeseriesSamplesLazy' : 'timeseriesSamplesZoomIn') : 'timeseriesSamplesToggle', checked: !!plot?.showSamples, disabled: !has || !!plot?.timeseriesStacked, waiting: !!samplesWaiting, run: () => this._toggleSamples(panelId) },
        ];
    };

    proto._marksActiveCount = function(plot) {
        if (!plot) return 0;
        return [plot.showNaN, plot.showGaps, plot.showRepeated, plot.showSamples]
            .filter(Boolean).length;
    };

    proto._createMarksButton = function(panelId, plot) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'layout-toolbar-btn panel-action-btn panel-toggle-btn timeseries-marks-btn';
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.title = i18n.t('marksMenuTitle');
        this._applyMarksButtonState(plot, button);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            if (this._marksMenuEl(panelId)) this._closeMarksMenu();
            else this._openMarksMenu(panelId, button);
        });
        return button;
    };

    proto._applyMarksButtonState = function(plot, button) {
        if (!button) return;
        const count = this._marksActiveCount(plot);
        const label = i18n.t('marksMenuLabel');
        button.textContent = count ? `${label} (${count}) ▾` : `${label} ▾`;
        button.classList.toggle('active', count > 0);
        button.disabled = !(this._hasContent?.(plot) && plot?.mode === 'timeseries');
    };

    proto._marksMenuEl = function(panelId) {
        return document.querySelector(`.timeseries-marks-menu[data-panel-id="${panelId}"]:not(.panel-view-menu)`);
    };

    // Closes whichever panel dropdown is open — Marks or View; one at a time.
    proto._closeMarksMenu = function() {
        const menu = document.querySelector('.timeseries-marks-menu');
        if (!menu) return;
        menu._cleanup?.();
        menu.remove();
        document.querySelectorAll('.timeseries-marks-btn[aria-expanded="true"], .panel-view-btn[aria-expanded="true"]')
            .forEach(button => button.setAttribute('aria-expanded', 'false'));
    };

    proto._openMarksMenu = function(panelId, anchor) {
        this._openPanelDropdown(panelId, anchor, 'marks');
    };

    // Shared by Marks and View: the menu is positioned under its button, stays
    // open while toggling, and Escape or a click outside closes it.
    proto._openPanelDropdown = function(panelId, anchor, kind) {
        this._closeMarksMenu();
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const isView = kind === 'view';
        const menu = document.createElement('div');
        menu.className = isView ? 'timeseries-marks-menu panel-view-menu' : 'timeseries-marks-menu';
        menu.dataset.panelId = String(panelId);
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', i18n.t(isView ? 'viewMenuLabel' : 'marksMenuLabel'));
        document.body.appendChild(menu);
        if (isView) this._renderViewMenu(panelId, menu);
        else this._renderMarksMenu(panelId, menu);
        anchor?.setAttribute('aria-expanded', 'true');
        const rect = anchor?.getBoundingClientRect?.();
        if (rect) {
            const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
            menu.style.left = `${Math.max(8, left)}px`;
            menu.style.top = `${Math.round(rect.bottom + 4)}px`;
        }
        const onPointer = (event) => {
            // The button toggles the menu itself (a rebuilt toolbar may have
            // replaced `anchor` since the menu opened).
            if (menu.contains(event.target) || event.target?.closest?.('.timeseries-marks-btn, .panel-view-btn')) return;
            this._closeMarksMenu();
        };
        const onKey = (event) => {
            if (event.key === 'Escape') {
                this._closeMarksMenu();
                anchor?.focus?.();
            }
        };
        menu._cleanup = () => {
            document.removeEventListener('pointerdown', onPointer, true);
            document.removeEventListener('keydown', onKey, true);
        };
        setTimeout(() => {
            if (!menu.isConnected) return;
            document.addEventListener('pointerdown', onPointer, true);
            document.addEventListener('keydown', onKey, true);
        }, 0);
        menu.querySelector('button:not(:disabled)')?.focus?.();
    };

    proto._renderMarksMenu = function(panelId, menu = this._marksMenuEl(panelId)) {
        if (!menu) return;
        const plot = this.plots.get(panelId);
        this._renderPanelMenuItems(panelId, menu, this._marksMenuModel(panelId, plot));
    };

    // Items: { divider } | { radio (line shape) } | a checkbox with an optional
    // settings gear. Every one runs its own toggle; the menu is re-rendered from
    // the plot state by the toggle (_syncMarksControls).
    proto._renderPanelMenuItems = function(panelId, menu, items) {
        menu.replaceChildren();
        for (const item of items) {
            if (item.divider) {
                const hr = document.createElement('div');
                hr.className = 'marks-menu-divider';
                hr.setAttribute('role', 'separator');
                menu.appendChild(hr);
                continue;
            }
            if (item.radio) {
                const row = document.createElement('div');
                row.className = 'marks-menu-radio-row';
                row.setAttribute('role', 'group');
                row.setAttribute('aria-label', i18n.t(item.label));
                const caption = document.createElement('span');
                caption.className = 'marks-menu-radio-caption';
                caption.textContent = i18n.t(item.label);
                row.appendChild(caption);
                for (const [value, key, title] of [
                    ['auto', 'lineShapeAuto', 'lineShapeAutoTitle'],
                    ['linear', 'lineShapeLinear', 'lineShapeLinearTitle'],
                    ['hv', 'lineShapeStairs', 'lineShapeStairsTitle'],
                ]) {
                    const option = document.createElement('button');
                    option.type = 'button';
                    option.className = `marks-menu-radio marks-line-${value}`;
                    option.setAttribute('role', 'menuitemradio');
                    const checked = item.value === value;
                    option.setAttribute('aria-checked', String(checked));
                    option.classList.toggle('checked', checked);
                    option.textContent = i18n.t(key);
                    option.title = i18n.t(title);
                    option.disabled = !!item.disabled;
                    option.addEventListener('click', (event) => {
                        event.stopPropagation();
                        this._setPanelLineShape(panelId, value);
                    });
                    row.appendChild(option);
                }
                menu.appendChild(row);
                continue;
            }
            const row = document.createElement('div');
            row.className = 'marks-menu-row';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `marks-menu-item marks-item-${item.key}`;
            button.dataset.mark = item.key;
            button.setAttribute('role', 'menuitemcheckbox');
            button.setAttribute('aria-checked', String(!!item.checked));
            button.classList.toggle('checked', !!item.checked);
            button.classList.toggle('marks-waiting', !!item.waiting);
            button.disabled = !!item.disabled;
            button.title = i18n.t(item.title);
            const box = document.createElement('span');
            box.className = 'marks-menu-check';
            box.setAttribute('aria-hidden', 'true');
            box.textContent = item.checked ? '✓' : '';
            const text = document.createElement('span');
            text.className = 'marks-menu-text';
            text.textContent = i18n.t(item.label);
            button.append(box, text);
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                item.run();
            });
            row.appendChild(button);
            if (item.settings) {
                const gear = document.createElement('button');
                gear.type = 'button';
                gear.className = 'marks-menu-settings';
                gear.textContent = '⚙';
                gear.title = i18n.t('timeseriesGapsSettings');
                gear.setAttribute('aria-label', i18n.t('timeseriesGapsSettings'));
                gear.disabled = !!item.disabled;
                gear.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this._closeMarksMenu();
                    item.settings();
                });
                row.appendChild(gear);
            }
            menu.appendChild(row);
        }
    };

    // ── View menu ──

    // How the panel's axes read its data: log scales, stacking, the right
    // axis, the line shape. Each mode lists what applies to it; the modes with
    // nothing to offer (heatmap, profile, integral) get a disabled button.
    proto._viewMenuModel = function(panelId, plot) {
        const mode = plot?.mode;
        const has = !!this._hasContent?.(plot);
        if (mode === 'timeseries') {
            return [
                { key: 'ylog', label: 'viewLogY', title: 'viewLogYTitle', checked: !!plot.timeseriesYLog, disabled: !has, run: () => this._toggleTimeseriesLogAxis(panelId, 'y') },
                { key: 'y2log', label: 'viewLogY2', title: plot.timeseriesY2Enabled ? 'viewLogY2Title' : 'viewLogY2Off', checked: !!(plot.timeseriesY2Enabled && plot.timeseriesY2Log), disabled: !has || !plot.timeseriesY2Enabled, run: () => this._toggleTimeseriesLogAxis(panelId, 'y2') },
                { divider: true },
                { key: 'stack', label: 'timeseriesStackLabel', title: 'timeseriesStackToggle', checked: !!plot.timeseriesStacked, disabled: !has, run: () => this._toggleTimeseriesStack(panelId) },
                { key: 'y2', label: 'timeseriesY2Label', title: 'timeseriesY2Toggle', checked: !!plot.timeseriesY2Enabled, disabled: !has, run: () => this._toggleTimeseriesY2(panelId) },
                { divider: true },
                { key: 'line', radio: true, label: 'lineShapeLabel', value: this._panelLineShapeState(plot), disabled: !has },
            ];
        }
        if (mode === 'phase2d') {
            return [
                { key: 'xlog', label: 'viewLogX', title: 'viewLogXTitle', checked: !!plot.phase2dXLog, disabled: !has, run: () => this._togglePhase2dLogAxis(panelId, 'x') },
                { key: 'ylog', label: 'viewLogY', title: 'viewLogYTitle', checked: !!plot.phase2dYLog, disabled: !has, run: () => this._togglePhase2dLogAxis(panelId, 'y') },
            ];
        }
        if (mode === 'fft') {
            const state = this._ensureFftState(plot);
            const period = state.xAxisMode === 'period';
            return [
                { key: 'freqlog', label: 'viewLogFrequency', title: period ? 'viewLogFrequencyPeriod' : 'viewLogFrequencyTitle', checked: period || !!state.freqLog, disabled: !has || period, run: () => this._toggleFftFrequencyLog(panelId) },
            ];
        }
        if (mode === 'histogram') {
            const state = this._ensureHistogramState(plot);
            return [
                { key: 'countlog', label: 'viewLogCounts', title: 'viewLogCountsTitle', checked: state.yScale === 'log', disabled: !has, run: () => this._toggleHistogramLogY(panelId) },
            ];
        }
        return [];
    };

    proto._viewActiveCount = function(plot) {
        return this._viewMenuModel(null, plot)
            .filter(item => item.checked && !item.disabled).length;
    };

    proto._createViewButton = function(panelId, plot) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'layout-toolbar-btn panel-action-btn panel-toggle-btn panel-view-btn';
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.title = i18n.t('viewMenuTitle');
        this._applyViewButtonState(plot, button);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            if (this._viewMenuEl(panelId)) this._closeMarksMenu();
            else this._openPanelDropdown(panelId, button, 'view');
        });
        return button;
    };

    proto._applyViewButtonState = function(plot, button) {
        if (!button) return;
        const items = this._viewMenuModel(null, plot);
        const count = items.filter(item => item.checked && !item.disabled).length;
        const label = i18n.t('viewMenuLabel');
        button.textContent = count ? `${label} (${count}) ▾` : `${label} ▾`;
        button.classList.toggle('active', count > 0);
        button.disabled = !(this._hasContent?.(plot) && items.length);
    };

    proto._viewMenuEl = function(panelId) {
        return document.querySelector(`.panel-view-menu[data-panel-id="${panelId}"]`);
    };

    proto._renderViewMenu = function(panelId, menu = this._viewMenuEl(panelId)) {
        if (!menu) return;
        const plot = this.plots.get(panelId);
        this._renderPanelMenuItems(panelId, menu, this._viewMenuModel(panelId, plot));
    };

    // Toolbar buttons and (when open) the menus, from the plot state.
    proto._syncMarksControls = function(panelId) {
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        const plot = this.plots.get(panelId);
        this._applyMarksButtonState(plot, panelEl?.querySelector('.timeseries-marks-btn'));
        this._applyViewButtonState(plot, panelEl?.querySelector('.panel-view-btn'));
        this._renderMarksMenu(panelId);
        this._renderViewMenu(panelId);
        // A mode change or a cleared panel turns Gaps off without its toggle.
        if (!(plot?.mode === 'timeseries' && plot.showGaps)) this._closeGapsPanel(panelId);
        this._refreshLogAxisNotice?.(plot);
    };

    // The same, from a plot (the refresh paths have the plot, not the id).
    // Only the open menu is re-rendered; the button text depends on the
    // toggles alone, which change through _syncMarksControls.
    proto._syncMarksControlsForPlot = function(plot) {
        const panelId = plot?.div?.closest?.('.layout-panel')?.dataset?.id;
        if (panelId === undefined || panelId === null) return;
        const menu = document.querySelector(`.timeseries-marks-menu[data-panel-id="${panelId}"]:not(.panel-view-menu)`);
        if (menu) this._renderMarksMenu(panelId, menu);
    };

    // ── Gaps panel ──

    proto._gapsPanelEl = function(panelId) {
        return document.querySelector(`.layout-panel[data-id="${panelId}"] .gaps-panel`);
    };

    proto._closeGapsPanel = function(panelId) {
        this._gapsPanelEl(panelId)?.remove();
    };

    proto._openGapsPanel = function(panelId) {
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        const plot = this.plots.get(panelId);
        if (!panelEl || !plot || plot.mode !== 'timeseries') return;
        if (!plot.showGaps) {
            // The ⚙ of an unchecked Gaps item: turn the tool on first.
            plot._gapsPanelShown = true;
            this._toggleGaps(panelId);
        }
        let panel = this._gapsPanelEl(panelId);
        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'gaps-panel';
            panel.setAttribute('role', 'dialog');
            panel.setAttribute('aria-label', i18n.t('gapsPanelTitle'));
            panel.addEventListener('pointerdown', event => event.stopPropagation());
            panel.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') this._closeGapsPanel(panelId);
            });
            panelEl.appendChild(panel);
        }
        this._renderGapsPanel(panelId);
        panel.querySelector('input')?.focus?.();
    };

    // Where the user dragged the panel, in px from the panel's top-left
    // (plot._gapsPanelPos), clamped so it stays inside the panel. Absent: the
    // CSS default, top right.
    proto._applyGapsPanelPosition = function(panelId, panel) {
        const pos = this.plots.get(panelId)?._gapsPanelPos;
        const host = panel?.parentElement;
        if (!pos || !host) return;
        const maxX = Math.max(6, host.clientWidth - panel.offsetWidth - 6);
        const maxY = Math.max(6, host.clientHeight - panel.offsetHeight - 6);
        panel.style.left = `${Math.max(6, Math.min(maxX, pos.x))}px`;
        panel.style.top = `${Math.max(6, Math.min(maxY, pos.y))}px`;
        panel.style.right = 'auto';
    };

    // Drag by the header, like the cursor readout. Pointer capture keeps the
    // move and release on the header itself, so nothing is bound to
    // `document` (and nothing outlives the panel). Mouse, pen and touch alike.
    proto._bindGapsPanelDrag = function(panelId, panel, header) {
        let drag = null;
        header.addEventListener('pointerdown', (event) => {
            if (event.button !== undefined && event.button !== 0) return;
            if (event.target.closest?.('.gaps-panel-close')) return;
            const host = panel.parentElement;
            if (!host) return;
            event.preventDefault();
            const rect = panel.getBoundingClientRect();
            drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
            header.setPointerCapture?.(event.pointerId);
            panel.classList.add('dragging');
        });
        // A pointerdown's default does not include text selection: the
        // mousedown's does, and a drag would select the page around the panel.
        header.addEventListener('mousedown', (event) => {
            if (!event.target.closest?.('.gaps-panel-close')) event.preventDefault();
        });
        header.addEventListener('pointermove', (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            const plot = this.plots.get(panelId);
            const hostRect = panel.parentElement?.getBoundingClientRect();
            if (!plot || !hostRect) return;
            plot._gapsPanelPos = {
                x: event.clientX - hostRect.left - drag.dx,
                y: event.clientY - hostRect.top - drag.dy,
            };
            this._applyGapsPanelPosition(panelId, panel);
        });
        const end = (event) => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            drag = null;
            header.releasePointerCapture?.(event.pointerId);
            panel.classList.remove('dragging');
        };
        header.addEventListener('pointerup', end);
        header.addEventListener('pointercancel', end);
    };

    // The unit ladder the Δt input offers, largest first; the unit shown is the
    // largest one the value reaches.
    const inputUnits = TIME_UNITS.filter(unit => unit.factor >= 1e-6);

    proto._gapSummaryText = function(fileId, step) {
        const data = this.files.get(fileId)?.data;
        if (!Number.isFinite(step.dt)) return '';
        const text = (gaps, missing) => i18n.t('gapsPanelResult')
            .replace('{gaps}', String(gaps))
            .replace('{missing}', String(Math.round(missing)));
        if (!data?._duckdb?.viewMode) {
            const times = this._getTransformedTimeData(fileId);
            const key = `${step.dt}\u0000${step.factor}`;
            const gaps = memo(this, `gaps:${key}`, times, () => detectGapIndices(times, step.dt, step.factor));
            return text(gaps.count, gaps.totalMissing);
        }
        const entry = this.files.get(fileId);
        const key = `${step.dt}\u0000${step.factor}`;
        const summary = entry._gapSummary;
        if (summary?.key === key && summary.status === 'ready') return text(summary.gaps, summary.missing);
        if (summary?.key === key && summary.status === 'error') return '';
        if (summary?.key !== key && data._duckdb.source?.getGapSummary) {
            const next = { key, status: 'pending' };
            entry._gapSummary = next;
            const scale = this._lazyDisplayScale(fileId);
            data._duckdb.source.getGapSummary(data, step.dt / scale, step.factor).then((result) => {
                Object.assign(next, { status: 'ready', gaps: result.gaps, missing: result.missing });
            }).catch((error) => {
                console.warn('[gaps] summary failed:', error);
                next.status = 'error';
            }).then(() => {
                for (const [panelId, plot] of this.plots) {
                    if (plot.traces.some(t => t.fileId === fileId)) this._renderGapsPanel(panelId);
                }
            });
        }
        return i18n.t('gapsPanelResultPending');
    };

    proto._renderGapsPanel = function(panelId) {
        const panel = this._gapsPanelEl(panelId);
        const plot = this.plots.get(panelId);
        if (!panel || !plot) return;
        // Re-rendering must not steal the field being typed in.
        const active = document.activeElement;
        if (active && panel.contains(active) && active.tagName === 'INPUT' && active.dataset.editing === '1') return;
        // Removing a focused field blurs it, and a blur can fire its `change`
        // (which commits, which renders): never render inside a render.
        if (panel._rendering) return;
        panel._rendering = true;
        try {
            this._fillGapsPanel(panelId, panel, plot);
        } finally {
            panel._rendering = false;
        }
    };

    proto._fillGapsPanel = function(panelId, panel, plot) {
        panel.replaceChildren();

        const header = document.createElement('div');
        header.className = 'gaps-panel-header';
        header.title = i18n.t('gapsPanelMove');
        const title = document.createElement('span');
        title.className = 'gaps-panel-title';
        // The same four-arrow glyph as the cursor readout: the header drags.
        title.innerHTML = MOVE_ICON_SVG;
        title.append(i18n.t('gapsPanelTitle'));
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'gaps-panel-close';
        close.textContent = '✕';
        close.title = i18n.t('gapsPanelClose');
        close.setAttribute('aria-label', i18n.t('gapsPanelClose'));
        close.addEventListener('click', () => this._closeGapsPanel(panelId));
        header.append(title, close);
        panel.appendChild(header);
        this._bindGapsPanelDrag(panelId, panel, header);

        const files = [];
        const seen = new Set();
        for (const t of plot.traces) {
            if (seen.has(t.fileId) || !this.files.get(t.fileId)) continue;
            seen.add(t.fileId);
            files.push(t.fileId);
        }
        for (const fileId of files) panel.appendChild(this._gapsPanelFileBlock(fileId, files.length > 1));
        // Once filled: the clamp needs the panel's final size.
        this._applyGapsPanelPosition(panelId, panel);
    };

    proto._gapsPanelFileBlock = function(fileId, showName) {
        const block = document.createElement('div');
        block.className = 'gaps-panel-file';
        block.dataset.fileId = String(fileId);
        if (showName) {
            const name = document.createElement('div');
            name.className = 'gaps-panel-file-name';
            name.textContent = this.files.get(fileId)?.name || String(fileId);
            block.appendChild(name);
        }
        const step = this._resolvedGapStep(fileId);
        const { secondsPerUnit, unitless } = this._gapAxisScale(fileId);

        // Δt row: number + unit (or the axis unit) + Auto.
        const stepRow = document.createElement('div');
        stepRow.className = 'gaps-panel-row';
        const stepLabel = document.createElement('label');
        stepLabel.className = 'gaps-panel-label';
        stepLabel.textContent = i18n.t('gapsPanelStep');
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'gaps-panel-step';
        input.min = '0';
        input.step = 'any';
        const unit = unitless
            ? { factor: 1, suffix: '' }
            : (Number.isFinite(step.dt) ? pickTimeUnit([step.dt * secondsPerUnit]) : { factor: 1, suffix: 's' });
        if (Number.isFinite(step.dt)) {
            input.value = String(Number(((step.dt * (unitless ? 1 : secondsPerUnit)) / unit.factor).toPrecision(6)));
            input.dataset.committed = input.value;
        }
        stepLabel.appendChild(input);
        stepRow.appendChild(stepLabel);
        let select = null;
        if (unitless) {
            const suffix = document.createElement('span');
            suffix.className = 'gaps-panel-unit';
            suffix.textContent = i18n.t('gapsPanelRows');
            stepRow.appendChild(suffix);
        } else {
            select = document.createElement('select');
            select.className = 'gaps-panel-unit';
            select.setAttribute('aria-label', i18n.t('gapsPanelUnit'));
            for (const u of inputUnits) {
                const option = document.createElement('option');
                option.value = String(u.factor);
                option.textContent = u.suffix;
                if (u.factor === unit.factor) option.selected = true;
                select.appendChild(option);
            }
            stepRow.appendChild(select);
        }
        const commit = () => {
            input.dataset.editing = '';
            const value = Number(input.value);
            if (!(value > 0) || input.dataset.committed === input.value) return;
            input.dataset.committed = input.value;
            const factor = select ? Number(select.value) : 1;
            const dt = unitless ? value : (value * factor) / secondsPerUnit;
            this._setGapSettings(fileId, { dt });
        };
        input.addEventListener('input', () => { input.dataset.editing = '1'; });
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') commit(); });
        select?.addEventListener('change', () => {
            // Changing the unit re-expresses the same Δt, it does not rescale it.
            if (!Number.isFinite(step.dt)) return;
            const factor = Number(select.value);
            input.value = String(Number(((step.dt * secondsPerUnit) / factor).toPrecision(6)));
            input.dataset.committed = input.value;
        });
        const auto = document.createElement('button');
        auto.type = 'button';
        auto.className = 'gaps-panel-auto';
        auto.textContent = i18n.t('gapsPanelAuto');
        auto.title = i18n.t('gapsPanelAutoTitle');
        auto.classList.toggle('active', !step.manual);
        auto.setAttribute('aria-pressed', String(!step.manual));
        auto.addEventListener('click', () => this._setGapSettings(fileId, { dt: null }));
        stepRow.appendChild(auto);
        block.appendChild(stepRow);

        const detected = document.createElement('div');
        detected.className = 'gaps-panel-note gaps-panel-detected';
        if (step.auto.pending) {
            detected.textContent = i18n.t('gapsPanelDetecting');
        } else if (!step.monotonic) {
            detected.textContent = i18n.t('gapsPanelUnsorted');
        } else if (!Number.isFinite(step.auto.dt)) {
            detected.textContent = i18n.t('gapsPanelNoStep');
        } else {
            const text = i18n.t('gapsPanelDetected')
                .replace('{dt}', this._formatGapStep(fileId, step.auto.dt))
                .replace('{percent}', String(Math.round((step.auto.agreement || 0) * 100)));
            detected.textContent = step.manual ? `${i18n.t('gapsPanelManual')} · ${text}` : text;
            detected.classList.toggle('gaps-panel-warning',
                Number.isFinite(step.auto.agreement) && step.auto.agreement < GAP_STEP_MIN_AGREEMENT);
        }
        block.appendChild(detected);

        // Threshold row.
        const thresholdRow = document.createElement('div');
        thresholdRow.className = 'gaps-panel-row';
        const thresholdLabel = document.createElement('label');
        thresholdLabel.className = 'gaps-panel-label';
        thresholdLabel.textContent = i18n.t('gapsPanelThreshold');
        const factorInput = document.createElement('input');
        factorInput.type = 'number';
        factorInput.className = 'gaps-panel-factor';
        factorInput.min = '1.01';
        factorInput.step = '0.1';
        factorInput.value = String(step.factor);
        thresholdLabel.appendChild(factorInput);
        const times = document.createElement('span');
        times.className = 'gaps-panel-unit';
        times.textContent = '× Δt';
        thresholdRow.append(thresholdLabel, times);
        const commitFactor = () => {
            factorInput.dataset.editing = '';
            const value = Number(factorInput.value);
            if (!(value > 1) || value === step.factor || factorInput.dataset.committed === factorInput.value) return;
            factorInput.dataset.committed = factorInput.value;
            this._setGapSettings(fileId, { factor: value });
        };
        factorInput.addEventListener('input', () => { factorInput.dataset.editing = '1'; });
        factorInput.addEventListener('change', commitFactor);
        factorInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') commitFactor(); });
        block.appendChild(thresholdRow);

        const hint = document.createElement('div');
        hint.className = 'gaps-panel-note';
        hint.textContent = Number.isFinite(step.dt)
            ? i18n.t('gapsPanelThresholdHint').replace('{value}', this._formatGapStep(fileId, step.dt * step.factor))
            : '';
        block.appendChild(hint);

        const result = document.createElement('div');
        result.className = 'gaps-panel-result';
        result.textContent = step.monotonic ? this._gapSummaryText(fileId, step) : '';
        block.appendChild(result);
        return block;
    };
}
