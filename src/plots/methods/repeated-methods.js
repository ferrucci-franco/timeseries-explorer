// The Repeated toggle (docs/repeated-timestamps-indicator-design.md): marks
// where a panel's time axis holds one instant on several consecutive rows, at
// any zoom.
//
// Two presentations, by zoom. Zoomed in, where the Samples dots are drawn (the
// toggle turns Samples on with it), each repeated sample gets a red ring and
// its hover says how many rows share the instant. Zoomed out, where no dots
// can be drawn, the repeats show as red bars on a strip along the top of the
// plot, with a hover label of our own (_ensureRepeatedHover): Plotly gives
// shapes none.
//
// The bars are layout shapes, sharing `layout.shapes` with the NaN/Inf strip
// (drawn just below them) and the Gaps bands. Earlier builds drew a triangle per repeat — first as annotations,
// whose redraw cost ~230 ms a frame and made panning crawl, then as pixel
// shapes — plus guide lines; the rings made both redundant. Being in data
// coordinates, the bars follow a pan by themselves and are recomputed only
// when it settles.
import i18n from '../../i18n/index.js';
import { repeatedTimestampRuns } from '../../utils/repeated-timestamps.js';
import { REPEATED_MARK_MIN_RUN, repeatedMarksForView } from '../../utils/repeated-marks.js';

export function installPlotRepeatedMethods(TargetClass) {
    const proto = TargetClass.prototype;
    const PlotManager = TargetClass;

    // Runs of one time column, computed once per array. Keyed by the array
    // itself, so a time vector that is replaced (a reload, a live append, a
    // time transform) is scanned again and never served stale runs.
    proto._repeatedRunsForTimes = function(times) {
        if (!times || typeof times !== 'object') return repeatedTimestampRuns(null);
        if (!this._repeatedRunsCache) this._repeatedRunsCache = new WeakMap();
        const minRun = PlotManager.REPEATED_MARK_MIN_RUN ?? REPEATED_MARK_MIN_RUN;
        const cached = this._repeatedRunsCache.get(times);
        if (cached && cached.minRun === minRun && cached.length === times.length) return cached.runs;
        const runs = repeatedTimestampRuns(times, minRun);
        this._repeatedRunsCache.set(times, { minRun, length: times.length, runs });
        return runs;
    };

    // One source per file on the panel. A memory-saving (DuckDB) file holds an
    // overview sample in memory, not its rows, so its repeats cannot be read
    // there; it is reported instead of scanned.
    proto._repeatedSources = function(plot, { visibleOnly = true } = {}) {
        const sources = [];
        let lazy = false;
        const seen = new Set();
        for (const t of plot?.traces || []) {
            if (visibleOnly && (t.visible === false || t.visible === 'legendonly')) continue;
            if (seen.has(t.fileId)) continue;
            seen.add(t.fileId);
            const data = this.files.get(t.fileId)?.data;
            if (!data) continue;
            if (data._duckdb) {
                lazy = true;
                continue;
            }
            const times = this._getTransformedTimeData(t.fileId);
            const runs = this._repeatedRunsForTimes(times);
            sources.push({ key: t.fileId, times, runs, color: t.color });
        }
        return { sources, lazy };
    };

    // 'some' — at least one file on the panel repeats an instant; 'none' —
    // none does (the button is disabled, and saying so is the answer); 'lazy' —
    // nothing found, but a memory-saving file could not be read.
    proto._repeatedAvailability = function(plot) {
        if (!plot?.traces?.length) return 'none';
        const { sources, lazy } = this._repeatedSources(plot, { visibleOnly: false });
        if (sources.some(source => source.runs.count > 0)) return 'some';
        return lazy ? 'lazy' : 'none';
    };

    // Red: apart from the amber of Gaps and the violet of NaN/Inf, and readable
    // on both themes.
    proto._repeatedColor = function(alpha = 1) {
        return this.theme === 'dark'
            ? `rgba(255, 82, 82, ${alpha})`
            : `rgba(211, 47, 47, ${alpha})`;
    };

    proto._repeatedHoverText = function(mark, names) {
        const text = mark.instants === 1
            ? i18n.t('timeseriesRepeatedOne').replace('{count}', String(mark.longest))
            : i18n.t('timeseriesRepeatedMany')
                .replace('{instants}', String(mark.instants))
                .replace('{count}', String(mark.longest));
        if (!names) return text;
        return `${text}<br>${mark.keys.map(key => this._escapeHTML(names.get(key) || key)).join(', ')}`;
    };

    // What to draw for the current view: the bars, and what their hover says.
    // A file whose trace shows its dots right now is left off the strip — its
    // repeats are ringed on the curve instead. `state` is 'lazy' when only
    // memory-saving files on the panel could hold repeats, else null.
    proto._repeatedOverlay = function(plot) {
        const empty = { shapes: [], hoverMarks: [], state: null };
        if (plot?.mode !== 'timeseries' || !plot.showRepeated || !plot.div) return empty;
        const xa = plot.div._fullLayout?.xaxis;
        if (!xa || !Array.isArray(xa.range) || !(xa._length > 0)) return empty;
        const lo = this._coerceAxisValue(xa.range[0]);
        const hi = this._coerceAxisValue(xa.range[1]);
        const { sources, lazy } = this._repeatedSources(plot);
        const dotted = new Set(plot.traces
            .filter(t => plot._sampleMarkerState?.get(t) === true)
            .map(t => t.fileId));
        const undotted = sources.filter(source => !dotted.has(source.key));
        const view = repeatedMarksForView(undotted, lo, hi, xa._length);

        const names = sources.length > 1
            ? new Map(sources.map(source => [source.key, this.files.get(source.key)?.name || source.key]))
            : null;
        const key = undotted.find(source => source.runs.count)?.key;
        const timeVar = key ? this._getTimeVar(key) : null;
        const shapes = view.regions.map(region => ({
            type: 'rect', xref: 'x', yref: 'paper',
            x0: this._plotlyTimeValue(key, region.t0, timeVar),
            x1: this._plotlyTimeValue(key, region.t1, timeVar),
            y0: 0.985, y1: 1,
            fillcolor: this._repeatedColor(0.85),
            line: { width: 0 },
            layer: 'above',
        }));
        const hoverMarks = view.marks.map(mark => ({
            x: this._plotlyTimeValue(mark.keys[0], mark.t, this._getTimeVar(mark.keys[0])),
            color: this._repeatedColor(1),
            text: this._repeatedHoverText(mark, names),
        }));
        const state = !view.marks.length && lazy && !sources.some(source => source.runs.count) ? 'lazy' : null;
        return { shapes, hoverMarks, state };
    };

    // Hover over the marks: Plotly gives shapes none, so a small label of our
    // own follows the pointer along the top strip. Installed once per plot div.
    proto._ensureRepeatedHover = function(plot) {
        const div = plot?.div;
        if (!div || div._repeatedHoverInstalled) return;
        div._repeatedHoverInstalled = true;
        let label = null;
        const hide = () => { if (label) label.style.display = 'none'; };
        div.addEventListener('mouseleave', hide);
        div.addEventListener('mousemove', (event) => {
            const marks = plot.showRepeated ? plot._repeatedHoverMarks : null;
            const layout = div._fullLayout;
            const xa = layout?.xaxis;
            if (!marks?.length || !xa || !layout._size) return hide();
            const rect = div.getBoundingClientRect();
            const px = event.clientX - rect.left;
            const py = event.clientY - rect.top;
            const top = layout._size.t;
            if (py < top - 2 || py > top + 12) return hide();
            let best = null;
            let bestDistance = 7;
            for (const mark of marks) {
                const markPx = xa._offset + xa.l2p(xa.d2l(mark.x));
                const distance = Math.abs(markPx - px);
                if (distance < bestDistance) {
                    best = mark;
                    bestDistance = distance;
                }
            }
            if (!best) return hide();
            if (!label) {
                label = document.createElement('div');
                label.className = 'repeated-hover-label';
                document.body.appendChild(label);
            }
            label.innerHTML = best.text;
            label.style.borderColor = best.color;
            label.style.left = `${event.clientX + 12}px`;
            label.style.top = `${event.clientY + 12}px`;
            label.style.display = 'block';
        });
    };

    // The rings the Repeated toggle puts on Samples dots: for each drawn point
    // of an exact window, how many rows share its instant (0 when it is alone).
    // Counted in the whole column, not the window, so a run cut by the edge of
    // the view still reads its full length.
    proto._repeatedRunLengthsForPoints = function(timeData, xs) {
        const n = xs?.length || 0;
        const lengths = new Array(n).fill(0);
        const minRun = PlotManager.REPEATED_MARK_MIN_RUN ?? REPEATED_MARK_MIN_RUN;
        for (let i = 0; i < n; i++) {
            const x = Number(xs[i]);
            if (!Number.isFinite(x)) continue;
            const atEdge = i === 0 || i === n - 1;
            const shared = (i > 0 && Number(xs[i - 1]) === x) || (i < n - 1 && Number(xs[i + 1]) === x);
            if (!shared && !atEdge) continue;
            const count = this._upperBound(timeData, x) - this._lowerBound(timeData, x);
            if (count >= minRun) lengths[i] = count;
        }
        return lengths;
    };

    // Per-point marker for a trace with dots: every sample keeps its filled dot
    // in the trace colour, and a repeated one gets a red ring around it.
    // `text` feeds the hover, since Plotly's hover picks only one of several
    // coincident points and cannot say how many there are.
    proto._repeatedSampleDecoration = function(t, lengths) {
        if (!lengths.some(Boolean)) return null;
        const ring = this._repeatedColor(1);
        const size = PlotManager.SAMPLE_MARKER_SIZE;
        return {
            marker: {
                color: t.color,
                size: lengths.map(k => (k ? size + 5 : size)),
                symbol: 'circle',
                line: {
                    color: lengths.map(k => (k ? ring : t.color)),
                    width: lengths.map(k => (k ? 2 : 0)),
                },
            },
            text: lengths.map(k => (k
                ? `<br>${this._escapeHTML(i18n.t('timeseriesRepeatedOne').replace('{count}', String(k)))}`
                : '')),
        };
    };
}
