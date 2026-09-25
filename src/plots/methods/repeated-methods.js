// The Repeated toggle (docs/repeated-timestamps-indicator-design.md): marks
// where a panel's time axis holds one instant on several consecutive rows, at
// any zoom.
//
// Marks are small layout shapes (triangles sized in pixels, anchored at their
// instant), not a trace and not annotations. A helper trace would have to be
// skipped by every piece of code that maps Plotly trace indexes back to
// plot.traces — hover, cursors, autoscale, export. Annotations were the first
// build: they carry a hover, but redrawing a hundred of them cost ~200 ms per
// frame and made panning crawl. Shapes cost a fraction of that and, being
// anchored in data coordinates, follow a pan by themselves, so they are only
// recomputed when it settles. Their hover is a small label of our own
// (_ensureRepeatedHover). Guide lines and the dense wash are shapes too; all of
// them share `layout.shapes` with the Missing/NaN bands.
import i18n from '../../i18n/index.js';
import { repeatedTimestampRuns } from '../../utils/repeated-timestamps.js';
import {
    REPEATED_GUIDE_MAX,
    REPEATED_MARK_MIN_RUN,
    repeatedMarksForView,
} from '../../utils/repeated-marks.js';

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

    // Magenta: apart from the amber of Missing/NaN and from the default trace
    // palette's first colours, and readable on both themes.
    proto._repeatedColor = function(alpha = 1) {
        return this.theme === 'dark'
            ? `rgba(240, 98, 146, ${alpha})`
            : `rgba(194, 24, 91, ${alpha})`;
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

    // What to draw for the current view. `state`: null (marks drawn), 'dense'
    // (too many to resolve: a wash on the strip instead), 'lazy' (only
    // memory-saving files on the panel have unread repeats) or 'none'.
    proto._repeatedOverlay = function(plot) {
        const empty = { shapes: [], hoverMarks: [], state: null };
        if (plot?.mode !== 'timeseries' || !plot.showRepeated || !plot.div) return empty;
        const xa = plot.div._fullLayout?.xaxis;
        if (!xa || !Array.isArray(xa.range) || !(xa._length > 0)) return empty;
        const lo = this._coerceAxisValue(xa.range[0]);
        const hi = this._coerceAxisValue(xa.range[1]);
        const { sources, lazy } = this._repeatedSources(plot);
        const view = repeatedMarksForView(sources, lo, hi, xa._length);

        const names = sources.length > 1
            ? new Map(sources.map(source => [source.key, this.files.get(source.key)?.name || source.key]))
            : null;
        const colorOf = new Map(sources.map(source => [source.key, source.color]));
        const markColor = (mark) => (names && mark.keys.length === 1 && colorOf.get(mark.keys[0])) || this._repeatedColor(1);
        const xOf = (mark) => this._plotlyTimeValue(mark.keys[0], mark.t, this._getTimeVar(mark.keys[0]));

        const shapes = [];
        const hoverMarks = [];
        if (view.dense) {
            // Individual marks would touch: shade the stretches of strip that
            // hold repeats, so it still shows where they are and where not.
            const key = sources.find(source => source.runs.count)?.key;
            const timeVar = key ? this._getTimeVar(key) : null;
            for (const region of view.regions) {
                shapes.push({
                    type: 'rect', xref: 'x', yref: 'paper',
                    x0: this._plotlyTimeValue(key, region.t0, timeVar),
                    x1: this._plotlyTimeValue(key, region.t1, timeVar),
                    y0: 0.985, y1: 1,
                    fillcolor: this._repeatedColor(0.45),
                    line: { width: 0 },
                    layer: 'above',
                });
            }
        } else {
            for (const mark of view.marks) {
                const color = markColor(mark);
                const x = xOf(mark);
                // A small triangle hanging from the top edge, sized in pixels
                // but anchored at its instant, so it rides along with a pan
                // without being redrawn.
                shapes.push({
                    type: 'path', xref: 'x', yref: 'paper',
                    xsizemode: 'pixel', ysizemode: 'pixel',
                    xanchor: x, yanchor: 1,
                    path: 'M-4.5,0 L4.5,0 L0,-8 Z',
                    fillcolor: color,
                    line: { width: 0 },
                    layer: 'above',
                });
                hoverMarks.push({ x, color, text: this._repeatedHoverText(mark, names) });
            }
            // Zoomed in far enough that each mark is one instant, and few of
            // them: a faint line takes the eye from the mark down to the curve.
            if (view.resolved && view.marks.length <= REPEATED_GUIDE_MAX) {
                for (const { x } of hoverMarks) {
                    shapes.push({
                        type: 'line', xref: 'x', yref: 'paper',
                        x0: x, x1: x, y0: 0, y1: 1,
                        line: { color: this._repeatedColor(0.35), width: 1, dash: 'dot' },
                        layer: 'below',
                    });
                }
            }
        }
        let state = null;
        if (view.dense) state = 'dense';
        else if (!view.marks.length && lazy && !sources.some(source => source.runs.count)) state = 'lazy';
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

    // Per-point marker for a trace with dots: plain dots, and a ring (open
    // circle with a centre dot, in the Repeated colour) on repeated samples.
    // `text` feeds the hover, since Plotly's hover picks only one of several
    // coincident points and cannot say how many there are.
    proto._repeatedSampleDecoration = function(t, lengths) {
        if (!lengths.some(Boolean)) return null;
        const ring = this._repeatedColor(1);
        const size = PlotManager.SAMPLE_MARKER_SIZE;
        return {
            marker: {
                color: lengths.map(k => (k ? ring : t.color)),
                size: lengths.map(k => (k ? size * 2 : size)),
                symbol: lengths.map(k => (k ? 'circle-open-dot' : 'circle')),
                line: { color: lengths.map(k => (k ? ring : t.color)), width: 1.5 },
            },
            text: lengths.map(k => (k
                ? `<br>${this._escapeHTML(i18n.t('timeseriesRepeatedOne').replace('{count}', String(k)))}`
                : '')),
        };
    };
}
