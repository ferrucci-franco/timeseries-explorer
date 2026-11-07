// State bands (docs/state-band-design.md): a text column of a file, drawn on a
// time-series panel as a flat band in its own lane under the numeric signals.
// The band never moves in Y; it changes colour where the value changes.
//
// A band is an ordinary entry of `plot.traces` ({ varName, fileId, color,
// axis }) whose variable is text: what makes it a band is decided where it is
// drawn, so sessions, removal, the phone's signal list and the dashboard need
// nothing new. Each band is ONE Plotly bar trace (horizontal, one bar per run,
// like a Gantt chart), which keeps `plot.traces[i]` and `div.data[i]` in step,
// the invariant every refresh relies on.
//
// The lanes are reserved, not overlaid: the numeric Y axis gives up the bottom
// of the plot (`yaxis.domain`), and a third, hidden axis (`yaxis3`) holds one
// lane per band, of a fixed height in pixels. The fraction that takes depends
// on the plot's height, so it is worked out again after every draw and resize.
import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';
import {
    STATE_BAND_COLUMN_PX,
    STATE_BAND_MAX_RUNS,
    STATE_BAND_MAX_VALUES,
    buildStateSegments,
    encodeStateRuns,
    extendStateRuns,
    normalizeStateValue,
    stateBandOverflows,
    stateRowAtOrBefore,
} from '../../utils/state-runs.js';
import {
    assignStateSlots,
    stateInkFor,
    stateNeutralColor,
    stateSlotStyle,
} from '../../utils/state-colors.js';
import { stateSegmentsFromColumns } from '../../data/state-runs-sql.js';

/** Height of one lane, in pixels. */
export const STATE_BAND_LANE_PX = 18;
/** Space between two lanes, in pixels. */
export const STATE_BAND_LANE_GAP_PX = 4;
/** The lanes never take more than this share of the plot's height. */
export const STATE_BAND_MAX_FRACTION = 0.4;
/** Space between the numeric plot and the first lane, in pixels. */
export const STATE_BAND_SEPARATION_PX = 8;
/** Height of the row of value chips under the plot, in pixels. */
export const STATE_BAND_LEGEND_PX = 20;
/** How long a notice about a band stays on screen. */
const STATE_BAND_NOTICE_MS = 4500;
/** Lane label: characters shown before it is cut. */
const LANE_LABEL_CHARS = 9;

export function installPlotStateBandMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // ── What is a band ──

    // A text series that runs along the time axis. Text parameters and the
    // metadata leaves of other formats are `plottable: false` or parameters
    // and stay what they were.
    proto._isStateBandVariable = function(variable) {
        return !!variable
            && variable.dataType === 'string'
            && variable.kind === 'variable'
            && variable.plottable !== false;
    };

    proto._isStateBandTrace = function(trace) {
        if (!trace) return false;
        const variable = this.files.get(trace.fileId)?.data?.variables?.[trace.varName];
        return this._isStateBandVariable(variable);
    };

    proto._stateBandTraces = function(plot) {
        if (!plot || plot.mode !== 'timeseries') return [];
        return (plot.traces || []).filter(t => this._isStateBandTrace(t));
    };

    proto._numericTimeTraces = function(plot) {
        return (plot?.traces || []).filter(t => !this._isStateBandTrace(t));
    };

    // ── Runs and values ──

    // Runs of a column, read once per array and continued when a live update
    // makes it longer (the same Array grows in place).
    proto._stateRunsFor = function(fileId, varName) {
        const data = this.files.get(fileId)?.data?.variables?.[varName]?.data;
        if (!data || typeof data !== 'object') return encodeStateRuns([]);
        if (!this._stateRunsCache) this._stateRunsCache = new WeakMap();
        let enc = this._stateRunsCache.get(data);
        if (!enc) enc = encodeStateRuns(data);
        else if (enc.length !== data.length) enc = extendStateRuns(enc, data);
        this._stateRunsCache.set(data, enc);
        return enc;
    };

    // The distinct values of a band's column, in order of first appearance in
    // the FILE, and whether there are too many to colour. A memory-saving file
    // asks DuckDB (the overview is a sample, and would give colours that
    // change with what it happened to keep); until it answers, the overview's
    // values stand in.
    proto._stateBandValues = function(trace) {
        const data = this.files.get(trace.fileId)?.data;
        if (data?._duckdb?.source?.getStateValues) {
            const cache = data._stateValues || (data._stateValues = new Map());
            const entry = cache.get(trace.varName);
            if (entry?.status === 'ready') {
                return { table: entry.values.slice(0, STATE_BAND_MAX_VALUES + 1), count: entry.values.length, overflow: stateBandOverflows(entry.values.length) };
            }
            if (!entry) this._requestLazyStateValues(trace.fileId, trace.varName);
        }
        const enc = this._stateRunsFor(trace.fileId, trace.varName);
        return { table: enc.table, count: enc.table.length, overflow: stateBandOverflows(enc.table.length) };
    };

    proto._requestLazyStateValues = function(fileId, varName) {
        const data = this.files.get(fileId)?.data;
        const source = data?._duckdb?.source;
        if (!source?.getStateValues) return;
        const cache = data._stateValues || (data._stateValues = new Map());
        if (cache.has(varName)) return;
        const entry = { status: 'pending', values: [] };
        cache.set(varName, entry);
        source.getStateValues(data, varName, STATE_BAND_MAX_VALUES).then((values) => {
            entry.values = values;
            entry.status = 'ready';
        }).catch((error) => {
            console.warn('[state band] distinct values failed:', error);
            entry.status = 'error';
        }).then(() => {
            if (this.files.get(fileId)?.data !== data || entry.status !== 'ready') return;
            for (const [panelId, plot] of this.plots) {
                if (!plot.div || plot.mode !== 'timeseries') continue;
                if (!plot.traces.some(t => t.fileId === fileId && t.varName === varName)) continue;
                this._refreshTimeseriesVisuals(panelId, plot);
                this._renderStateBandLegend(plot);
            }
        });
    };

    // One colour per value across the bands of a panel, in the order the
    // bands were added and, within a band, the order its file holds them.
    // A band with too many values keeps out of it (it alternates greys).
    proto._stateBandColorMap = function(plot) {
        const map = new Map();
        for (const trace of this._stateBandTraces(plot)) {
            const values = this._stateBandValues(trace);
            if (!values.overflow) assignStateSlots(map, values.table);
        }
        return map;
    };

    proto._stateBandIsDark = function() {
        return this.theme === 'dark';
    };

    // ── Lanes ──

    proto._stateBandPlotHeight = function(plot, margin) {
        const measured = plot?.div?._fullLayout?._size?.h;
        if (measured > 0) return measured;
        const total = plot?.div?.clientHeight || plot?.div?.parentElement?.clientHeight || 300;
        return Math.max(60, total - (margin?.t || 0) - (margin?.b || 0));
    };

    // The domain the numeric axis keeps and the one the lanes take.
    proto._stateBandDomains = function(plot, laneCount, plotHeight) {
        if (!laneCount) return { numeric: [0, 1], lanes: null };
        const height = Math.max(1, plotHeight);
        const lanes = Math.min(STATE_BAND_MAX_FRACTION, laneCount * (STATE_BAND_LANE_PX + STATE_BAND_LANE_GAP_PX) / height);
        const numericCount = this._numericTimeTraces(plot).length;
        const separation = numericCount ? Math.min(0.05, STATE_BAND_SEPARATION_PX / height) : 0;
        const round = v => Math.round(v * 10000) / 10000;
        return { numeric: [round(Math.min(0.95, lanes + separation)), 1], lanes: [0, round(lanes)] };
    };

    // Lane i (0 = the top lane) is [n − 1 − i, n − i] on yaxis3.
    proto._stateBandLaneCenter = function(laneIndex, laneCount) {
        return laneCount - laneIndex - 0.5;
    };

    proto._stateBandLaneIndex = function(plot, trace) {
        return this._stateBandTraces(plot).indexOf(trace);
    };

    // Add the lanes to a time-series layout built by _buildTimeLayout. With no
    // band on the panel the layout is left exactly as it was.
    proto._applyStateBandLayout = function(plot, layout) {
        const bands = this._stateBandTraces(plot);
        if (!bands.length || !layout?.yaxis) return layout;
        // A layout built afresh has the margin without any growth for the chips.
        plot._stateBandMarginBumps = 0;
        const { fontColor } = this._colors();
        layout.margin = { ...(layout.margin || {}) };
        layout.margin.b = (layout.margin.b || 0) + STATE_BAND_LEGEND_PX;
        const n = bands.length;
        const domains = this._stateBandDomains(plot, n, this._stateBandPlotHeight(plot, layout.margin));
        layout.yaxis.domain = domains.numeric;
        if (!this._numericTimeTraces(plot).length) {
            layout.yaxis.visible = false;
            layout.yaxis.showgrid = false;
        }
        layout.yaxis3 = {
            domain: domains.lanes,
            anchor: 'x',
            range: [0, n],
            visible: false,
            fixedrange: true,
            showgrid: false,
            zeroline: false,
        };
        // The time axis goes under the lanes, at the bottom of the plot: on
        // the numeric axis it would draw its ticks across them.
        if (layout.xaxis) layout.xaxis.anchor = 'y3';
        layout.barmode = 'overlay';
        layout.bargap = 0;
        layout.uniformtext = { mode: 'hide', minsize: 9 };
        layout.annotations = (layout.annotations || [])
            .filter(a => !String(a?.name || '').startsWith('state-band-label'))
            .concat(bands.map((trace, index) => this._stateBandLaneLabel(trace, index, n, fontColor)));
        return layout;
    };

    proto._stateBandLaneLabel = function(trace, laneIndex, laneCount, fontColor) {
        const full = this._traceName(trace.varName, trace.fileId, { units: false });
        const short = full.length > LANE_LABEL_CHARS ? `${full.slice(0, LANE_LABEL_CHARS - 1)}…` : full;
        return {
            name: `state-band-label:${laneIndex}`,
            xref: 'paper',
            x: 0,
            xanchor: 'right',
            xshift: -4,
            yref: 'y3',
            y: this._stateBandLaneCenter(laneIndex, laneCount),
            yanchor: 'middle',
            text: this._escapeHTML(short),
            hovertext: `${this._escapeHTML(full)}<br>${this._escapeHTML(i18n.t('stateBandRemoveHint'))}`,
            showarrow: false,
            captureevents: true,
            font: { size: 9, color: fontColor },
        };
    };

    // The relayout that brings an existing chart's axes in line with its
    // bands: lanes added or removed, the Y axis shown or hidden, the time
    // axis under the lanes or back on Y. Everything else stays.
    proto._stateBandLayoutUpdate = function(plot) {
        const layout = this._buildTimeLayout(plot);
        const hasBands = !!layout.yaxis3;
        const curves = this._numericTimeTraces(plot).length > 0;
        return {
            margin: layout.margin,
            'yaxis.domain': layout.yaxis.domain || [0, 1],
            'yaxis.visible': curves || !hasBands,
            'yaxis.showgrid': curves || !hasBands,
            'yaxis.title': layout.yaxis.title,
            yaxis3: hasBands ? layout.yaxis3 : null,
            'xaxis.anchor': hasBands ? 'y3' : 'y',
            annotations: layout.annotations || [],
            barmode: layout.barmode || 'group',
            bargap: layout.bargap ?? null,
            uniformtext: layout.uniformtext || { mode: false },
        };
    };

    // Add time-series entries already pushed on `plot.traces` to the chart on
    // screen, when bands are or will be on it. The lanes are laid out first,
    // so a bar never lands on an axis that is not there yet; then the traces
    // join in one call, before the hover marker, as every add does; then the
    // view is drawn (the other bands' lanes moved).
    proto._addTimeTracesBesideBands = function(panelId, plot, states) {
        const div = plot.div;
        if (!div) return Promise.resolve();
        const range = div._fullLayout?.xaxis?.range || div.layout?.xaxis?.range || null;
        const built = states
            .map(state => this._buildTimeTrace(state, range, plot, plot.traces.indexOf(state)))
            .filter(Boolean);
        const insertAt = Number.isInteger(plot.markerTraceIdx) ? plot.markerTraceIdx : null;
        return Plotly.relayout(div, this._stateBandLayoutUpdate(plot))
            .then(() => {
                if (plot.div !== div || !built.length) return null;
                return insertAt === null
                    ? Plotly.addTraces(div, built)
                    : Plotly.addTraces(div, built, built.map((_, i) => insertAt + i));
            })
            .then((added) => {
                if (plot.div !== div) return;
                if (added && insertAt !== null) plot.markerTraceIdx += built.length;
                this._syncTimeseriesMarkerColors(plot);
                this._installLegendHoverHint(div);
                this._refreshTimeseriesVisuals(panelId, plot);
                this._syncCursorDisplay(panelId, plot);
                this._syncAudioStrip?.(panelId);
            })
            .catch(error => console.warn('[state band] adding traces failed:', error));
    };

    // After a draw or a resize: the lanes are a share of the plot's height in
    // pixels, so a height that changed moves the domains.
    proto._syncStateBandLanes = function(plot) {
        if (!plot?.div?._fullLayout || plot.mode !== 'timeseries') return;
        const bands = this._stateBandTraces(plot);
        if (!bands.length) return;
        const domains = this._stateBandDomains(plot, bands.length, this._stateBandPlotHeight(plot));
        const current = plot.div._fullLayout.yaxis3?.domain;
        if (!current || Math.abs(current[1] - domains.lanes[1]) < 0.002) return;
        Plotly.relayout(plot.div, { 'yaxis.domain': domains.numeric, 'yaxis3.domain': domains.lanes });
    };

    // Shift+click on a lane's label takes the band off, as Shift+click on a
    // legend entry does for a curve (a band has no legend entry).
    proto._installStateBandLabelEvents = function(panelId, plot) {
        if (!plot?.div?.on) return;
        plot.div.on('plotly_clickannotation', (event) => {
            const name = String(event?.annotation?.name || '');
            if (!name.startsWith('state-band-label:')) return;
            if (!event?.event?.shiftKey) return;
            const laneIndex = Number(name.split(':')[1]);
            const band = this._stateBandTraces(plot)[laneIndex];
            if (!band) return;
            this._removeTimeseriesTraceAt(panelId, plot.traces.indexOf(band));
        });
    };

    // ── The band trace ──

    // The view of a band: segments and the labels to go with them. Eager files
    // read their own runs; a memory-saving file draws what its last query
    // brought back for this view (or the overview while it waits).
    proto._stateBandSegments = function(trace, plot, visibleRange) {
        const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        const [rawLo, rawHi] = (visibleRange || []).map(v => this._coerceAxisValue(v));
        const lo = Number.isFinite(rawLo) ? Math.min(rawLo, rawHi) : -Infinity;
        const hi = Number.isFinite(rawHi) ? Math.max(rawLo, rawHi) : Infinity;
        const widthPx = plot?.div?._fullLayout?._size?.w || plot?.div?.clientWidth || 1000;
        const lazy = trace._stateLazy;
        if (lazy && lazy.data === this.files.get(trace.fileId)?.data
            && Number.isFinite(lo) && lazy.lo <= lo + 1e-9 && lazy.hi >= hi - 1e-9 && lazy.widthPx === Math.round(widthPx)) {
            return { segments: lazy.segments, reduced: lazy.reduced };
        }
        const enc = this._stateRunsFor(trace.fileId, trace.varName);
        const data = this.files.get(trace.fileId)?.data;
        const lastStep = data?._duckdb ? 0 : Number(this._autoGapStep?.(trace.fileId, trace.varName)?.dt) || 0;
        const built = buildStateSegments(enc, times, { lo, hi, widthPx, lastStep, maxRuns: STATE_BAND_MAX_RUNS, columnPx: STATE_BAND_COLUMN_PX });
        return {
            segments: built.segments.map(s => ({ t0: s.t0, t1: s.t1, value: enc.table[s.code], changes: s.changes })),
            reduced: built.reduced,
        };
    };

    // Fill colour, hatch and ink of every segment of a band.
    proto._stateBandStyles = function(plot, trace, segments, colorMap = null) {
        const dark = this._stateBandIsDark();
        const values = this._stateBandValues(trace);
        const map = colorMap || this._stateBandColorMap(plot);
        const colors = [];
        const patterns = [];
        const inks = [];
        segments.forEach((segment, index) => {
            let color;
            let pattern = '';
            if (values.overflow || !map.has(segment.value)) {
                color = stateNeutralColor(index, dark);
            } else {
                const style = stateSlotStyle(map.get(segment.value), dark);
                color = style.color;
                pattern = style.pattern;
            }
            colors.push(color);
            patterns.push(pattern);
            inks.push(stateInkFor(color));
        });
        return { colors, patterns, inks };
    };

    proto._stateBandDurationLabel = function(fileId, duration) {
        if (!Number.isFinite(duration)) return '';
        if (this._isCalendarTime(fileId) && !this._isHighResolutionGeneratedCalendarTime(fileId)) {
            return this._formatElapsedDateTime(duration / 1000, duration % 1000 ? 3 : 0);
        }
        const unit = this._timeUnitLabel(fileId);
        if (unit === 'duration' || unit === 'datetime') return this._formatElapsedDateTime(duration);
        return `${this._formatHTMLNumber(duration)}${unit ? ` ${unit}` : ''}`;
    };

    // The Plotly trace of one band for the visible range (null: the whole file).
    proto._buildStateBandTrace = function(trace, visibleRange = null, plot = null, colorMap = null) {
        const data = this.files.get(trace.fileId)?.data;
        if (!data?.variables?.[trace.varName]) return null;
        const bands = this._stateBandTraces(plot);
        const laneCount = Math.max(1, bands.length);
        const laneIndex = Math.max(0, bands.indexOf(trace));
        const center = this._stateBandLaneCenter(laneIndex, laneCount);
        const timeVar = this._getTimeVar(trace.fileId);
        const { segments, reduced } = this._stateBandSegments(trace, plot, visibleRange);
        // Drawn clipped to the view (a little past it, for a pan), so that a
        // run reaching off screen writes its value in the part that shows;
        // the hover keeps its real start and end.
        const [viewLo, viewHi] = (visibleRange || []).map(v => this._coerceAxisValue(v));
        const pad = Number.isFinite(viewLo) && Number.isFinite(viewHi) ? Math.abs(viewHi - viewLo) * 0.02 : 0;
        const clipLo = Number.isFinite(viewLo) ? Math.min(viewLo, viewHi) - pad : -Infinity;
        const clipHi = Number.isFinite(viewHi) ? Math.max(viewLo, viewHi) + pad : Infinity;
        const drawn = segments
            .filter(s => s.t1 > s.t0)
            .map(s => ({ ...s, d0: Math.max(s.t0, clipLo), d1: Math.min(s.t1, clipHi) }))
            .filter(s => s.d1 > s.d0);
        const { colors, patterns, inks } = this._stateBandStyles(plot, trace, drawn, colorMap);
        const changesText = i18n.t('stateBandChanges');
        const customdata = drawn.map(s => [
            s.value,
            this._formatTimeValue(trace.fileId, s.t0),
            this._formatTimeValue(trace.fileId, s.t1),
            this._stateBandDurationLabel(trace.fileId, s.t1 - s.t0),
            reduced && s.changes ? `<br>${changesText.replace('{n}', String(s.changes))}` : '',
        ]);
        const name = this._traceName(trace.varName, trace.fileId);
        const hoverName = this._escapeHTML(this._traceName(trace.varName, trace.fileId, { units: false }));
        const hoverBody = i18n.t('stateBandHover')
            .replace('{value}', '%{customdata[0]}')
            .replace('{from}', '%{customdata[1]}')
            .replace('{to}', '%{customdata[2]}')
            .replace('{duration}', '%{customdata[3]}');
        const { bg } = this._colors();
        return {
            type: 'bar',
            orientation: 'h',
            name,
            meta: { stateBand: true },
            showlegend: false,
            visible: trace.visible === false ? false : true,
            yaxis: 'y3',
            base: this._plotlyTimeArray(trace.fileId, drawn.map(s => s.d0), timeVar),
            x: drawn.map(s => s.d1 - s.d0),
            y: drawn.map(() => center),
            width: STATE_BAND_LANE_PX / (STATE_BAND_LANE_PX + STATE_BAND_LANE_GAP_PX),
            marker: {
                color: colors,
                line: { width: 1, color: bg },
                pattern: { shape: patterns, fillmode: 'overlay', fgcolor: inks, fgopacity: 0.45, size: 6, solidity: 0.25 },
            },
            text: drawn.map(s => this._escapeHTML(s.value)),
            textposition: 'inside',
            insidetextanchor: 'middle',
            constraintext: 'inside',
            cliponaxis: true,
            textfont: { color: inks, size: 10 },
            customdata,
            hovertemplate: `<b>${hoverName}</b> = ${hoverBody}%{customdata[4]}<extra></extra>`,
        };
    };

    // Restyle every band of a panel for a new view, in one call. Bars carry
    // more than x/y, so the bands do not ride in the numeric restyle.
    proto._refreshStateBands = function(plot, range = null) {
        if (!plot?.div || plot.mode !== 'timeseries') return null;
        const colorMap = this._stateBandColorMap(plot);
        const update = { base: [], x: [], y: [], 'marker.color': [], 'marker.line.color': [], 'marker.pattern.shape': [], 'marker.pattern.fgcolor': [], text: [], 'textfont.color': [], customdata: [] };
        const indices = [];
        plot.traces.forEach((trace, index) => {
            if (!this._isStateBandTrace(trace)) return;
            const built = this._buildStateBandTrace(trace, range, plot, colorMap);
            if (!built) return;
            update.base.push(built.base);
            update.x.push(built.x);
            update.y.push(built.y);
            update['marker.color'].push(built.marker.color);
            update['marker.line.color'].push(built.marker.line.color);
            update['marker.pattern.shape'].push(built.marker.pattern.shape);
            update['marker.pattern.fgcolor'].push(built.marker.pattern.fgcolor);
            update.text.push(built.text);
            update['textfont.color'].push(built.textfont.color);
            update.customdata.push(built.customdata);
            indices.push(index);
        });
        if (!indices.length) return null;
        // Restyling x makes Plotly guess the axis type again, from the data:
        // a bar's x is a length in ms, so a panel of bands alone would turn its
        // date axis into a number line. The type the axis has goes with it.
        // A type set again counts as a new axis and is autoranged, so the
        // range goes with it too. Plotly.update emits plotly_update, not the
        // plotly_relayout a zoom is read from: no refresh answers this one.
        const xaxis = plot.div.layout?.xaxis || {};
        const layoutUpdate = {};
        if (xaxis.type && xaxis.type !== '-') {
            layoutUpdate['xaxis.type'] = xaxis.type;
            if (Array.isArray(xaxis.range) && xaxis.autorange === false) {
                layoutUpdate['xaxis.range'] = xaxis.range.slice();
                layoutUpdate['xaxis.autorange'] = false;
            }
        }
        const drawn = Object.keys(layoutUpdate).length
            ? Plotly.update(plot.div, update, layoutUpdate, indices)
            : Plotly.restyle(plot.div, update, indices);
        this._renderStateBandLegend(plot);
        return drawn;
    };

    // A theme change: the dark steps of the palette, the background as the
    // hairline between runs, the lane labels in the theme's ink.
    proto._refreshStateBandsForTheme = function(plot) {
        if (!plot?.div?._fullLayout || plot.mode !== 'timeseries' || !this._stateBandTraces(plot).length) return;
        this._refreshStateBands(plot, plot.div._fullLayout.xaxis?.range || null);
        const { fontColor } = this._colors();
        const update = {};
        (plot.div.layout.annotations || []).forEach((annotation, index) => {
            if (String(annotation?.name || '').startsWith('state-band-label')) update[`annotations[${index}].font.color`] = fontColor;
        });
        if (Object.keys(update).length) Plotly.relayout(plot.div, update);
    };

    // ── Memory-saving files ──

    // Ask DuckDB for what each band of a lazy file draws in [t0, t1] (display
    // units), then restyle. Latest view wins.
    proto._refreshStateBandsLazy = function(panelId, plot, t0, t1) {
        if (!plot?.div || plot.mode !== 'timeseries') return;
        const bands = this._stateBandTraces(plot).filter(t => this.files.get(t.fileId)?.data?._duckdb?.source?.getStateRuns);
        if (!bands.length) return;
        const token = (plot._stateBandLazyToken || 0) + 1;
        plot._stateBandLazyToken = token;
        const widthPx = Math.round(plot.div._fullLayout?._size?.w || plot.div.clientWidth || 1000);
        const columns = Math.max(1, Math.ceil(widthPx / STATE_BAND_COLUMN_PX));
        const lo = Math.min(t0, t1);
        const hi = Math.max(t0, t1);
        Promise.all(bands.map(async (trace) => {
            const data = this.files.get(trace.fileId)?.data;
            if (trace._stateLazy && trace._stateLazy.data === data
                && trace._stateLazy.lo <= lo && trace._stateLazy.hi >= hi && trace._stateLazy.widthPx === widthPx) return;
            const timeVar = this._getTimeVar(trace.fileId);
            const sourceRange = this._sourceRangeForDisplayRange(trace.fileId, [lo, hi], timeVar);
            if (!sourceRange || !sourceRange.every(Number.isFinite)) return;
            const [s0, s1] = sourceRange[0] <= sourceRange[1] ? sourceRange : [sourceRange[1], sourceRange[0]];
            const result = await data._duckdb.source.getStateRuns(data, trace.varName, s0, s1, { maxRuns: STATE_BAND_MAX_RUNS, columns });
            if (plot._stateBandLazyToken !== token) return;
            const toDisplay = (value, index = null) => this._displayTimeForFetchedSourceTime(trace.fileId, value, index, timeVar);
            let segments;
            let reduced = false;
            if (result.mode === 'columns') {
                reduced = true;
                segments = stateSegmentsFromColumns(result.rows, s0, s1, result.columns)
                    .map(s => ({ ...s, t0: toDisplay(s.t0), t1: toDisplay(s.t1) }));
            } else {
                // Changes in view; the last value holds to the end of the file
                // (or the view, whichever comes first).
                const times = Array.from(result.t, (value, index) => toDisplay(value, index));
                const values = result.values.map(normalizeStateValue);
                const fileEnd = toDisplay(Number(data.metadata?.timeEnd));
                if (times.length) {
                    times.push(Number.isFinite(fileEnd) ? Math.max(times[times.length - 1], Math.min(fileEnd, hi)) : hi);
                    values.push(values[values.length - 1]);
                }
                const enc = encodeStateRuns(values);
                const built = buildStateSegments(enc, times, { lo, hi, widthPx, maxRuns: Infinity });
                segments = built.segments.map(s => ({ t0: s.t0, t1: s.t1, value: enc.table[s.code], changes: 0 }));
            }
            Object.defineProperty(trace, '_stateLazy', {
                configurable: true,
                writable: true,
                value: { data, lo, hi, widthPx, segments, reduced },
            });
        })).then(() => {
            if (plot._stateBandLazyToken !== token || !plot.div || !this.plots.has(panelId)) return;
            const range = plot.div._fullLayout?.xaxis?.range || null;
            this._refreshStateBands(plot, range);
        }).catch((error) => {
            console.warn('[state band] lazy runs failed:', error);
        });
    };

    // ── Reading a value at an instant ──

    // The value a band holds at time t (the trace's own time units): the last
    // row at or before t. '' before the first row and on an empty cell.
    proto._stateBandValueAt = function(trace, t) {
        const times = this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
        const data = this.files.get(trace.fileId)?.data;
        const lazy = trace._stateLazy;
        if (data?._duckdb && lazy?.data === data && lazy.lo <= t && t <= lazy.hi && !lazy.reduced) {
            const hit = lazy.segments.find(s => s.t0 <= t && t < s.t1);
            return hit ? hit.value : '';
        }
        const row = stateRowAtOrBefore(times, t);
        if (row < 0) return '';
        return normalizeStateValue(data?.variables?.[trace.varName]?.data?.[row]);
    };

    // Colour a value has on a panel (for the hover's swatch and the chips).
    proto._stateBandValueColor = function(plot, trace, value, colorMap = null) {
        const values = this._stateBandValues(trace);
        const map = colorMap || this._stateBandColorMap(plot);
        if (values.overflow || !map.has(value)) return stateNeutralColor(0, this._stateBandIsDark());
        return stateSlotStyle(map.get(value), this._stateBandIsDark()).color;
    };

    // One line of the shared hover box for a band.
    proto._stateBandHoverLine = function(plot, trace, t, colorMap = null) {
        const value = this._stateBandValueAt(trace, t);
        const label = this._traceName(trace.varName, trace.fileId, { units: false });
        const swatch = value ? this._stateBandValueColor(plot, trace, value, colorMap) : 'transparent';
        return `<span style="color:${swatch}">■</span> ${this._escapeHTML(label)} = ${value ? this._escapeHTML(value) : '—'}`;
    };

    // Rows of the A|B readout: what each band holds at A and at B. A cursor
    // measures a curve (Δy, slope); a state has no difference, only a value.
    proto._stateBandCursorRows = function(plot, aX, bX) {
        const bands = this._stateBandTraces(plot).filter(t => this._isVisible(t));
        if (!bands.length) return '';
        const colorMap = this._stateBandColorMap(plot);
        const primary = this._primaryTimeFileId?.(plot) ?? plot.traces[0]?.fileId;
        const cell = (trace, x) => {
            const t = this._mapTimeValueBetweenFiles(primary, trace.fileId, x);
            const value = Number.isFinite(t) ? this._stateBandValueAt(trace, t) : '';
            if (!value) return '—';
            const color = this._stateBandValueColor(plot, trace, value, colorMap);
            return `<span style="color:${color}">■</span> ${this._escapeHTML(value)}`;
        };
        return bands.map(trace => {
            const label = this._escapeHTML(this._traceName(trace.varName, trace.fileId, { units: false }));
            return `<div class="cursor-state-row"><b>${label}</b>: ${cell(trace, aX)} → ${cell(trace, bX)}</div>`;
        }).join('');
    };

    // ── The row of value chips ──

    proto._renderStateBandLegend = function(plot) {
        const div = plot?.div;
        if (!div) return;
        let row = div.querySelector(':scope > .state-band-legend');
        const bands = this._stateBandTraces(plot);
        if (!bands.length || plot.mode !== 'timeseries') {
            row?.remove();
            return;
        }
        if (!row) {
            row = document.createElement('div');
            row.className = 'state-band-legend';
            row.setAttribute('role', 'list');
            div.appendChild(row);
        }
        const dark = this._stateBandIsDark();
        const map = this._stateBandColorMap(plot);
        const chips = [];
        for (const [value, slot] of map) {
            const style = stateSlotStyle(slot, dark);
            chips.push({ value, color: style.color, hatched: !!style.pattern });
        }
        const overflowBands = bands.filter(t => this._stateBandValues(t).overflow);
        const size = div._fullLayout?._size;
        row.style.left = `${size?.l ?? 55}px`;
        row.style.right = `${size?.r ?? 15}px`;
        row.style.color = this._colors().fontColor;
        this._placeStateBandLegend(plot, row);
        const signature = JSON.stringify([chips, overflowBands.map(t => t.varName), row.style.color]);
        if (row.dataset.signature === signature) return;
        row.dataset.signature = signature;
        row.replaceChildren();
        for (const chip of chips) {
            const item = document.createElement('span');
            item.className = 'state-band-chip';
            item.setAttribute('role', 'listitem');
            const swatch = document.createElement('span');
            swatch.className = `state-band-swatch${chip.hatched ? ' hatched' : ''}`;
            swatch.style.backgroundColor = chip.color;
            const text = document.createElement('span');
            text.textContent = chip.value;
            item.append(swatch, text);
            item.title = chip.value;
            row.appendChild(item);
        }
        for (const trace of overflowBands) {
            const item = document.createElement('span');
            item.className = 'state-band-chip state-band-chip-many';
            item.setAttribute('role', 'listitem');
            const swatch = document.createElement('span');
            swatch.className = 'state-band-swatch striped';
            const text = document.createElement('span');
            text.textContent = i18n.t('stateBandManyChip')
                .replace('{name}', this._traceName(trace.varName, trace.fileId, { units: false }));
            item.append(swatch, text);
            row.appendChild(item);
        }
    };

    // Under the time axis's title, wherever the layout put it: on the phone
    // its margin grows to fit larger labels, and a row pinned to the bottom
    // ended up under the title. When the row does not fit, the margin grows.
    proto._placeStateBandLegend = function(plot, row) {
        const div = plot.div;
        const title = div.querySelector('.g-xtitle text') || div.querySelector('.xtick text');
        if (!title) return;
        const divRect = div.getBoundingClientRect();
        const top = Math.ceil(title.getBoundingClientRect().bottom - divRect.top + 3);
        row.style.top = `${top}px`;
        row.style.bottom = 'auto';
        const overflow = top + STATE_BAND_LEGEND_PX - div.clientHeight;
        if (overflow > 1 && (plot._stateBandMarginBumps || 0) < 2 && div._fullLayout?.margin) {
            plot._stateBandMarginBumps = (plot._stateBandMarginBumps || 0) + 1;
            Plotly.relayout(div, { 'margin.b': div._fullLayout.margin.b + overflow });
        }
    };

    // ── Notices ──

    proto._showStateBandNotice = function(panelId, message) {
        const plot = this.plots.get(panelId);
        const panelEl = plot?.div?.closest('.layout-panel')
            || (typeof document !== 'undefined' ? document.querySelector(`.layout-panel[data-id="${panelId}"]`) : null);
        if (!panelEl || !message) return;
        let pill = panelEl.querySelector('.state-band-notice');
        if (!pill) {
            pill = document.createElement('div');
            pill.className = 'lazy-detail-indicator state-band-notice';
            pill.setAttribute('aria-live', 'polite');
            pill.innerHTML = '<span class="lazy-detail-text"></span>';
            panelEl.appendChild(pill);
        }
        pill.querySelector('.lazy-detail-text').textContent = message;
        pill.title = message;
        pill.classList.add('active');
        clearTimeout(pill._stateBandTimer);
        pill._stateBandTimer = setTimeout(() => pill.remove(), STATE_BAND_NOTICE_MS);
    };

    // A band dropped on a panel says, once, when its column has too many
    // values to be coloured by value.
    proto._noticeStateBandOverflow = function(panelId, trace) {
        const values = this._stateBandValues(trace);
        if (!values.overflow) return;
        // After the redraw the band causes: tearing a chart down clears the
        // panel's pills.
        setTimeout(() => this._showStateBandOverflowNotice(panelId, trace, values), 0);
    };

    proto._showStateBandOverflowNotice = function(panelId, trace, values) {
        const label = this._traceName(trace.varName, trace.fileId, { units: false });
        this._showStateBandNotice(panelId, i18n.t('stateBandTooManyValues')
            .replace('{name}', label)
            .replace('{n}', values.count > STATE_BAND_MAX_VALUES + 1 || !this.files.get(trace.fileId)?.data?._duckdb
                ? String(values.count)
                : `> ${STATE_BAND_MAX_VALUES}`));
    };
}
