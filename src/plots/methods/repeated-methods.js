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
import { REPEATED_MARK_MIN_RUN, repeatedMarkColumns, repeatedMarksForView } from '../../utils/repeated-marks.js';

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

    // One source per file on the panel. A file in memory gives its time
    // column and the runs in it. A memory-saving (DuckDB) file holds an
    // overview sample in memory, not its rows, so its runs are found in the
    // file, by DuckDB (`lazyFiles`, see _repeatedLazyMarks).
    proto._repeatedSources = function(plot, { visibleOnly = true } = {}) {
        const sources = [];
        const lazyFiles = [];
        const seen = new Set();
        for (const t of plot?.traces || []) {
            if (visibleOnly && (t.visible === false || t.visible === 'legendonly')) continue;
            if (seen.has(t.fileId)) continue;
            seen.add(t.fileId);
            const data = this.files.get(t.fileId)?.data;
            if (!data) continue;
            if (data._duckdb) {
                lazyFiles.push({ key: t.fileId, data, color: t.color });
                continue;
            }
            const times = this._getTransformedTimeData(t.fileId);
            const runs = this._repeatedRunsForTimes(times);
            sources.push({ key: t.fileId, times, runs, color: t.color });
        }
        return { sources, lazyFiles };
    };

    // How many repeated instants a lazy file holds in all: a number once a
    // pass over it has said (any window's pass counts the whole file), and
    // undefined until then. A time axis generated from the row number repeats
    // nothing. Forgotten when Live Update appends rows.
    proto._repeatedLazyTotal = function(data) {
        const meta = data?._duckdb;
        if (!meta) return undefined;
        if (meta.generatedTime) return 0;
        const known = this._repeatedLazyTotals?.get(data);
        return known && known.rows === (Number(meta.appendRows) || 0) ? known.total : undefined;
    };

    // 'some' — at least one file on the panel repeats an instant; 'none' —
    // none does (the item says so); 'lazy' — none found yet, and a
    // memory-saving file has not been read to know.
    proto._repeatedAvailability = function(plot) {
        if (!plot?.traces?.length) return 'none';
        const { sources, lazyFiles } = this._repeatedSources(plot, { visibleOnly: false });
        if (sources.some(source => source.runs.count > 0)) return 'some';
        const totals = lazyFiles.map(file => this._repeatedLazyTotal(file.data));
        if (totals.some(total => total > 0)) return 'some';
        return totals.some(total => total === undefined) ? 'lazy' : 'none';
    };

    // The column marks of a lazy file for the view [lo, hi] (display units)
    // cut into `columns`: what repeatedMarksForView reduces a file's runs to,
    // computed by DuckDB over the file (DuckDbSource.getRepeatedColumns).
    // Returns them when they are in hand for exactly this view. Otherwise it
    // asks for them — one request per plot and file, a newer view replacing
    // the one it supersedes — and returns `pending` with what the previous
    // view drew (`stale`), which stays on screen until the answer redraws.
    proto._repeatedLazyMarks = function(plot, file, lo, hi, columns, widthPx) {
        const none = { marks: [], stale: null, pending: false };
        const { key: fileId, data } = file;
        const meta = data._duckdb;
        const source = meta?.source;
        if (!source?.getRepeatedColumns || meta.generatedTime) return none;
        const timeVar = this._getTimeVar(fileId);
        const sourceRange = this._sourceRangeForDisplayRange(fileId, [lo, hi], timeVar);
        if (!sourceRange || !sourceRange.every(Number.isFinite)) return none;
        const minRun = PlotManager.REPEATED_MARK_MIN_RUN ?? REPEATED_MARK_MIN_RUN;
        const rows = Number(meta.appendRows) || 0;
        const key = [sourceRange[0], sourceRange[1], lo, hi, columns, minRun, rows].join('\u0001');
        if (!plot._repeatedLazy) {
            // Not enumerable: working state, never part of a saved view.
            Object.defineProperty(plot, '_repeatedLazy', { value: new Map(), configurable: true, writable: true });
        }
        let entry = plot._repeatedLazy.get(fileId);
        if (!entry) {
            entry = { key: null, marks: null, view: null, pendingKey: null, failedKey: null, controller: null };
            plot._repeatedLazy.set(fileId, entry);
        }
        if (entry.data !== data) {
            entry.controller?.abort();
            Object.assign(entry, { data, key: null, marks: null, view: null, pendingKey: null, failedKey: null, controller: null });
        }
        if (entry.key === key && entry.marks) return { marks: entry.marks, stale: null, pending: false };
        if (entry.failedKey === key) return none;
        if (entry.pendingKey !== key) {
            entry.controller?.abort();
            const controller = new AbortController();
            entry.controller = controller;
            entry.pendingKey = key;
            new Promise(resolve => resolve(
                source.getRepeatedColumns(data, sourceRange[0], sourceRange[1], columns, { minRun, signal: controller.signal })))
                .then((result) => {
                    if (Number.isFinite(result?.total)) {
                        if (!this._repeatedLazyTotals) this._repeatedLazyTotals = new WeakMap();
                        this._repeatedLazyTotals.set(data, { rows, total: result.total });
                    }
                    if (entry.pendingKey !== key || entry.controller !== controller) return;
                    entry.pendingKey = null;
                    entry.controller = null;
                    entry.key = key;
                    entry.marks = (result?.marks || []).map(mark => ({
                        ...mark,
                        t: this._displayTimeForFetchedSourceTime(fileId, mark.t, null, timeVar),
                        key: fileId,
                    }));
                    entry.view = repeatedMarksForView([], lo, hi, widthPx, undefined, entry.marks);
                    this._repeatedLazyArrived(plot);
                })
                .catch((error) => {
                    if (entry.controller === controller) {
                        entry.controller = null;
                        entry.pendingKey = null;
                        if (error?.name !== 'AbortError') entry.failedKey = key;
                    }
                    if (error?.name !== 'AbortError') console.warn('[repeated] lazy marks failed:', error?.message || error);
                });
        }
        return { marks: [], stale: entry.view, pending: true };
    };

    // Stop reading a plot's lazy marks (the toggle went off, the panel is gone).
    proto._cancelRepeatedLazy = function(plot) {
        for (const entry of plot?._repeatedLazy?.values() || []) {
            entry.controller?.abort();
            entry.controller = null;
            entry.pendingKey = null;
        }
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
    // repeats are ringed on the curve instead. `state` is 'lazy' while a
    // memory-saving file is being read and there is nothing to draw yet.
    proto._repeatedOverlay = function(plot) {
        const empty = { shapes: [], hoverMarks: [], state: null };
        if (plot?.mode !== 'timeseries' || !plot.showRepeated || !plot.div) return empty;
        const xa = plot.div._fullLayout?.xaxis;
        if (!xa || !Array.isArray(xa.range) || !(xa._length > 0)) return empty;
        const lo = this._coerceAxisValue(xa.range[0]);
        const hi = this._coerceAxisValue(xa.range[1]);
        const { sources, lazyFiles } = this._repeatedSources(plot);
        const dotted = new Set(plot.traces
            .filter(t => plot._sampleMarkerState?.get(t) === true)
            .map(t => t.fileId));
        const undotted = sources.filter(source => !dotted.has(source.key));
        // Lazy files: their column marks, read from the file. One still being
        // read keeps what it drew for the previous view.
        const columns = repeatedMarkColumns(xa._length);
        const columnMarks = [];
        const stale = [];
        let pending = false;
        for (const file of lazyFiles) {
            // Ringed on its dots — unless the file has never been read, which
            // is what says whether it repeats an instant at all.
            if (dotted.has(file.key) && this._repeatedLazyTotal(file.data) !== undefined) continue;
            const lazy = this._repeatedLazyMarks(plot, file, lo, hi, columns, xa._length);
            if (dotted.has(file.key)) continue;
            if (lazy.pending) pending = true;
            if (lazy.stale) stale.push(lazy.stale);
            columnMarks.push(...lazy.marks);
        }
        const view = repeatedMarksForView(undotted, lo, hi, xa._length, undefined, columnMarks);
        const regions = [...view.regions, ...stale.flatMap(old => old.regions)];
        const marks = [...view.marks, ...stale.flatMap(old => old.marks)];

        const fileCount = sources.length + lazyFiles.length;
        const names = fileCount > 1
            ? new Map([...sources, ...lazyFiles].map(source => [source.key, this.files.get(source.key)?.name || source.key]))
            : null;
        const key = marks[0]?.keys?.[0] ?? null;
        const timeVar = key ? this._getTimeVar(key) : null;
        const shapes = regions.map(region => ({
            type: 'rect', xref: 'x', yref: 'paper',
            x0: this._plotlyTimeValue(key, region.t0, timeVar),
            x1: this._plotlyTimeValue(key, region.t1, timeVar),
            y0: 0.985, y1: 1,
            fillcolor: this._repeatedColor(0.85),
            line: { width: 0 },
            layer: 'above',
        }));
        const hoverMarks = marks.map(mark => ({
            x: this._plotlyTimeValue(mark.keys[0], mark.t, this._getTimeVar(mark.keys[0])),
            color: this._repeatedColor(1),
            text: this._repeatedHoverText(mark, names),
        }));
        const state = pending && !marks.length ? 'lazy' : null;
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
