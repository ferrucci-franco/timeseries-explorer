// How long does each analysis hold the main thread?
//
// #174 was a lazy FFT that froze the page: the read of its rows was one
// main-thread task of eight seconds on a 10 M-row file. That one is fixed and
// guarded (scripts/e2e-lazy-fft-responsive.mjs). This harness asks the same
// question of every analysis, on a file in memory-saving (lazy) mode and on
// the same file loaded in memory (eager).
//
// For each file size × loading mode × analysis × action it records:
//
//   · the longest main-thread task (PerformanceObserver `longtask`), split
//     with a CPU profile of the action into the time spent inside Plotly, the
//     time with no JavaScript running at all (style, layout and the
//     compositor's commit — the paint, which headless Chromium does with
//     software WebGL) and the rest: the computation and the read;
//   · the largest gap between animation frames and between ticks of a 10 ms
//     timer, as a cross-check that does not depend on the longtask observer;
//   · the time from the action to the result;
//   · whether a newer request stops the one in flight.
//
// Actions, in this order, on each analysis:
//
//   open    pick the analysis;
//   type    type both bounds of the range (10 % … 90 % of the file, or
//           --range=lo,hi);
//   param   change one parameter (a second, heavier one where there is one),
//           and put it back before the next action;
//   drag    type a bound, and while that recompute is in flight drag the
//           slider of the same bound and let go;
//   cancel  ask for a recompute and press Cancel on the computing pill.
//
// The files are generated CSVs of time,a,b: a numeric time axis sampled at
// 4 kHz (so the audio strip can play it) and a calendar one (the heatmap and
// the temporal profile need a calendar). They are written to --dir and kept
// there between runs.
//
//   node scripts/bench-analysis-responsiveness.mjs \
//       [--rows=1200000,10000000] [--modes=lazy,eager] \
//       [--analyses=fft,histogram,…] [--actions=open,type,param,drag,cancel] \
//       [--dir=<where the CSVs go>] [--out=results.json] [--md=table.md] \
//       [--range=0.1,0.9] [--limit=250] [--profile=false] [--timeout=900000] \
//       [--headed]
//   node scripts/bench-analysis-responsiveness.mjs --report=a.json,b.json
//
// Every action runs under V8's sampling profiler (CDP `Profiler`, one sample
// every 0.5 ms). It is what splits a task into computation and paint, and
// what names, for each task whose computation is over --limit ms, the
// functions that held the thread. --profile=false measures without it (the
// split then only knows the synchronous part of each Plotly call).
//
// Not in any CI chain: it measures, it asserts nothing. Needs a Chromium for
// Playwright.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// ─── Arguments ────────────────────────────────────────────────────────────

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    return match ? [match[1], match[2] ?? 'true'] : [arg, 'true'];
}));
const list = (value, fallback) => (value ? String(value).split(',').map(item => item.trim()).filter(Boolean) : fallback);
const ROWS = list(args.rows, ['1200000', '10000000']).map(Number);
const MODES = list(args.modes, ['lazy', 'eager']);
const ACTIONS = list(args.actions, ['open', 'type', 'param', 'drag', 'cancel']);
const LIMIT_MS = Number(args.limit || 250);
const PROFILE = args.profile !== 'false';
const DIR = args.dir || path.join(os.tmpdir(), 'analysis-responsiveness');
const ACTION_TIMEOUT_MS = Number(args.timeout || 900000);
const HEADED = args.headed === 'true';
// The range the `type` action types, as fractions of the file's time span.
const [RANGE_LO, RANGE_HI] = list(args.range, ['0.1', '0.9']).map(Number);

// ─── The analyses ─────────────────────────────────────────────────────────
//
// `file`: which of the two CSVs the analysis is measured on. `panel`: the
// time-series panel (signal a) or the 2D one (the pair b → a). `params`: the
// parameter changes, each a function body run in the page with (pm, id, plot).

const TIME_ANALYSES = [
    {
        id: 'fft', label: 'FFT', file: 'numeric', mode: 'fft',
        params: [{ name: 'window: none → Hann', run: `pm._ensureFftState(plot).windowType = 'hann'; pm._scheduleFftRecompute(id);`,
            after: `pm._ensureFftState(plot).windowType = 'none'; pm._scheduleFftRecompute(id);` }],
    },
    {
        id: 'histogram', label: 'Histogram', file: 'numeric', mode: 'histogram',
        params: [{ name: 'bins: auto → 40', run: `Object.assign(pm._ensureHistogramState(plot), { binMode: 'count', binCount: 40 }); pm._scheduleHistogramRecompute(id);`,
            after: `pm._ensureHistogramState(plot).binMode = 'auto'; pm._scheduleHistogramRecompute(id);` }],
    },
    {
        id: 'heatmap', label: 'Heatmap', file: 'calendar', mode: 'heatmap',
        params: [{ name: 'week × day → day × hour', run: `pm._ensureCalendarHeatmapState(plot).calendarMode = 'day-hour'; pm._scheduleCalendarHeatmapRecompute(id);`,
            after: `pm._ensureCalendarHeatmapState(plot).calendarMode = 'week-day'; pm._scheduleCalendarHeatmapRecompute(id);` }],
    },
    {
        id: 'temporal-profile', label: 'Temporal profile', file: 'calendar', mode: 'temporal-profile',
        params: [{ name: 'period: day → week', run: `pm._ensureTemporalProfileState(plot).period = 'week'; pm._scheduleTemporalProfileRecompute(id);`,
            after: `pm._ensureTemporalProfileState(plot).period = 'day'; pm._scheduleTemporalProfileRecompute(id);` }],
    },
    {
        id: 'integral', label: 'Integral', file: 'numeric', mode: 'integral',
        params: [{ name: 'trapezoidal → rectangular', run: `pm._ensureIntegralState(plot).method = 'rectangular'; pm._scheduleIntegralRecompute(id);`,
            after: `pm._ensureIntegralState(plot).method = 'trapezoidal'; pm._scheduleIntegralRecompute(id);` }],
    },
    {
        id: 'integral-calendar', label: 'Integral (calendar axis)', file: 'calendar', mode: 'integral',
        params: [{ name: 'group by: none → day', run: `pm._ensureIntegralState(plot).groupBy = 'day'; pm._scheduleIntegralRecompute(id);`,
            after: `pm._ensureIntegralState(plot).groupBy = 'none'; pm._scheduleIntegralRecompute(id);` }],
    },
    {
        id: 'curve-fit', label: 'Curve fit', file: 'numeric', mode: 'curve-fit',
        afterOpen: `pm._updateCurveFitEntry(id, { model: 'linear' });`,
        params: [
            { name: 'linear → quadratic', run: `pm._updateCurveFitEntry(id, { model: 'quadratic' });` },
            { name: 'quadratic → exponential', run: `pm._updateCurveFitEntry(id, { model: 'exponential' });`, after: `pm._updateCurveFitEntry(id, { model: 'linear' });` },
        ],
    },
    {
        id: 'trend', label: 'Trend', file: 'numeric', mode: 'trend',
        params: [
            { name: 'value band on', run: `pm._updateTrendSegment(id, { bandOn: true, lower: -2.5, upper: 2.5 });`, after: `pm._updateTrendSegment(id, { bandOn: false });` },
            { name: 'exponential on', run: `pm._updateTrendSegment(id, { expModel: 'exponential' });`, after: `pm._updateTrendSegment(id, { expModel: 'none' });` },
        ],
    },
];
const PAIR_ANALYSES = [
    {
        id: 'correlation', label: 'Correlation (pairs)', file: 'numeric', pick: 'correlation',
        // One method only (Pearson): nothing to change but the range.
        params: [],
    },
    {
        id: 'phase2d-fit', label: '2D curve fit', file: 'numeric', pick: 'phase2d-fit',
        afterOpen: `for (const pair of plot.phaseTraces) pair.fitModel = 'linear'; pm._schedulePhase2dFitRecompute(id, { immediate: true });`,
        params: [
            { name: 'linear → quadratic', run: `for (const pair of plot.phaseTraces) pair.fitModel = 'quadratic'; pm._schedulePhase2dFitRecompute(id, { immediate: true });` },
            { name: 'quadratic → exponential', run: `for (const pair of plot.phaseTraces) pair.fitModel = 'exponential'; pm._schedulePhase2dFitRecompute(id, { immediate: true });`,
                after: `for (const pair of plot.phaseTraces) pair.fitModel = 'linear'; pm._schedulePhase2dFitRecompute(id, { immediate: true });` },
        ],
    },
];
// Measured with their own steps: not analyses of the menu with a range block.
const OTHER = [
    { id: 'timeseries', label: 'Time series (the plot itself)', file: 'numeric' },
    { id: 'phase2d', label: '2D plot (trajectory b → a)', file: 'numeric' },
    { id: 'xcorr', label: 'Cross-correlation (data tool)', file: 'numeric' },
    { id: 'audio', label: 'Audio (prepare and play)', file: 'numeric' },
];
const ALL_IDS = [...OTHER.slice(0, 1), ...TIME_ANALYSES, ...OTHER.slice(1, 2), ...PAIR_ANALYSES, ...OTHER.slice(2)].map(item => item.id);
const WANTED = new Set(list(args.analyses, ALL_IDS));
for (const id of WANTED) if (!ALL_IDS.includes(id)) throw new Error(`unknown analysis "${id}" (known: ${ALL_IDS.join(', ')})`);

// ─── The files ────────────────────────────────────────────────────────────

function csvPath(kind, rows) {
    return path.join(DIR, `${kind}-${rows}.csv`);
}

function ensureCsv(kind, rows) {
    const file = csvPath(kind, rows);
    if (fs.existsSync(file)) return file;
    fs.mkdirSync(DIR, { recursive: true });
    const fd = fs.openSync(`${file}.part`, 'w');
    const start = Date.UTC(2023, 0, 1, 0, 0, 0);
    let buf = ['time,a,b'];
    for (let i = 0; i < rows; i++) {
        const a = Math.sin(i * 0.0123) * 3 + Math.sin(i * 0.31) * 0.5 + ((i * 7919) % 101) / 500;
        const b = Math.cos(i * 0.002) * 10;
        // Numeric: 4 kHz. Calendar: one row every 3 s (10 M rows: 347 days).
        const t = kind === 'calendar'
            ? new Date(start + i * 3000).toISOString().slice(0, 19).replace('T', ' ')
            : (i * 0.00025).toFixed(5);
        buf.push(`${t},${a.toFixed(6)},${b.toFixed(5)}`);
        if (buf.length >= 100000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; }
    }
    if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n');
    fs.closeSync(fd);
    fs.renameSync(`${file}.part`, file);
    return file;
}

// ─── In the page ──────────────────────────────────────────────────────────

// Before the app loads: every Worker made, and when it is terminated.
function initScript() {
    const NativeWorker = window.Worker;
    const log = window.__benchWorkers = [];
    window.Worker = class BenchWorker extends NativeWorker {
        constructor(url, options) {
            super(url, options);
            this.__entry = { url: String(url).split('/').pop().split('?')[0], created: performance.now(), terminated: null, posts: 0, lastPost: null };
            log.push(this.__entry);
        }

        terminate() {
            this.__entry.terminated = performance.now();
            return super.terminate();
        }

        postMessage(...rest) {
            this.__entry.posts++;
            this.__entry.lastPost = performance.now();
            return super.postMessage(...rest);
        }
    };
}

// After the file is loaded: the observers and the logs.
function installBench() {
    const pm = window.app.plotManager;
    const now = () => performance.now();
    const B = window.__bench = {
        long: [], raf: [], timer: [], plotly: [], pill: [], queries: [], clicks: [],
        workers: window.__benchWorkers || [],
        slow: false,
    };

    new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) B.long.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });

    // The cross-check: frames and a 10 ms timer, and how late each came.
    let lastFrame = now();
    const frame = () => {
        const t = now();
        if (t - lastFrame > 50) B.raf.push({ end: t, gap: t - lastFrame });
        lastFrame = t;
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    let lastTick = now();
    setInterval(() => {
        const t = now();
        if (t - lastTick > 50) B.timer.push({ end: t, gap: t - lastTick });
        lastTick = t;
    }, 10);

    // Every outermost Plotly call: the paint.
    const describe = (gd) => {
        const el = typeof gd === 'string' ? document.getElementById(gd) : gd;
        return el?.className ? String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.') : '';
    };
    let depth = 0;
    const wrap = (owner, fn) => {
        const original = owner?.[fn];
        if (typeof original !== 'function') return;
        owner[fn] = function wrapped(gd) {
            if (depth) return original.apply(this, arguments);
            depth++;
            const start = now();
            try {
                return original.apply(this, arguments);
            } finally {
                depth--;
                B.plotly.push({ start, end: now(), fn, target: describe(gd) });
            }
        };
    };
    for (const fn of ['react', 'newPlot', 'restyle', 'relayout', 'update', 'redraw', 'addTraces', 'deleteTraces',
        'extendTraces', 'prependTraces', 'moveTraces', 'purge', 'animate']) wrap(window.Plotly, fn);
    wrap(window.Plotly?.Plots, 'resize');

    // The computing pill going on and off.
    const setComputing = pm._setAnalysisComputing;
    pm._setAnalysisComputing = function (plot) {
        const before = !!plot?._analysisPill;
        const out = setComputing.apply(this, arguments);
        const after = !!plot?._analysisPill;
        if (before !== after) B.pill.push({ t: now(), on: after, panelId: this._panelIdForPlot?.(plot) });
        return out;
    };

    // The queries and streams of a lazy file: when each starts and ends, how
    // it ends, and whether its signal was aborted.
    //
    // A query or stream that starts while B.slow is set is slowed down: a
    // stream's chunks arrive 150 ms apart, and a query's answer is held back
    // (unless its signal aborts first). That lasts until B.slowUntil — one
    // second after the newer request — so that on any machine, however fast
    // its DuckDB, the older request is still in flight when the newer one
    // arrives, and whether it is then aborted can be seen. What the newer
    // request starts is never slowed.
    B.slowUntil = Infinity;
    const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    const hold = (signal) => new Promise((resolve, reject) => {
        const tick = () => {
            if (signal.aborted) return reject(abortError());
            if (now() >= B.slowUntil) return resolve();
            return setTimeout(tick, 20);
        };
        tick();
    });
    const entryFor = (kind, sql, signal) => {
        const entry = { kind, start: now(), end: null, outcome: null, signal: !!signal, abortedAt: null, chunks: 0, slow: B.slow,
            sql: String(sql).replace(/\s+/g, ' ').trim().slice(0, 90) };
        signal?.addEventListener?.('abort', () => { if (entry.end === null) entry.abortedAt = now(); }, { once: true });
        B.queries.push(entry);
        return entry;
    };
    const sources = new Set([...pm.files.values()].map(file => file?.data?._duckdb?.source).filter(Boolean));
    for (const source of sources) {
        const query = source._interactiveQuery.bind(source);
        source._interactiveQuery = (sql, options = {}) => {
            const entry = entryFor('query', sql, options?.signal);
            let pending = query(sql, options);
            if (entry.slow && options?.signal) pending = pending.then(result => hold(options.signal).then(() => result));
            return pending.then(
                (result) => { entry.end = now(); entry.outcome = 'ok'; return result; },
                (error) => { entry.end = now(); entry.outcome = error?.name || 'error'; throw error; },
            );
        };
        const stream = source._streamSql.bind(source);
        source._streamSql = async function* slowable(sql, toChunk, options = {}) {
            const entry = entryFor('stream', sql, options?.signal);
            try {
                for await (const chunk of stream(sql, toChunk, options)) {
                    entry.chunks++;
                    // 150 ms, cut short by an abort: the delay is not the
                    // stream's, and must not make it look slow to stop.
                    if (entry.slow && now() < B.slowUntil) {
                        await new Promise((resolve) => {
                            const timer = setTimeout(resolve, 150);
                            options?.signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
                        });
                    }
                    yield chunk;
                }
                entry.outcome = 'ok';
            } catch (error) {
                entry.outcome = error?.name || 'error';
                throw error;
            } finally {
                entry.end = now();
                // The consumer stopped reading before the end.
                if (!entry.outcome) entry.outcome = 'closed';
            }
        };
    }

    // A click, and how long after the press the page took it.
    document.addEventListener('click', (event) => {
        B.clicks.push({ t: now(), delay: now() - event.timeStamp, cancel: !!event.target?.closest?.('.analysis-cancel-btn') });
    }, true);

    B.reset = () => {
        for (const key of ['long', 'raf', 'timer', 'plotly', 'pill', 'queries', 'clicks']) B[key].length = 0;
    };
    B.collect = () => JSON.parse(JSON.stringify({
        now: now(), long: B.long, raf: B.raf, timer: B.timer, plotly: B.plotly, pill: B.pill,
        queries: B.queries, clicks: B.clicks, workers: B.workers,
    }));

    // The range block every analysis shares (analysis-range-methods.js).
    const panelEl = id => document.querySelector(`.layout-panel[data-id="${id}"]`);
    const control = (id, key, role) => panelEl(id)?.querySelector(`input[data-analysis-range-key="${key}"][data-analysis-range-role="${role}"]`);
    B.range = (id) => {
        const slider = control(id, 'x1', 'slider');
        const field = control(id, 'x1', 'input');
        const full = panelEl(id)?.querySelector('[data-analysis-range-full="true"]');
        if (!slider || !field) return null;
        const min = Number(slider.min);
        const max = Number(slider.max);
        return {
            min, max,
            calendar: field.type === 'datetime-local',
            full: !!full?.classList.contains('active'),
            x1: Number(control(id, 'x1', 'slider').value),
            x2: Number(control(id, 'x2', 'slider').value),
        };
    };
    // How much of the file the analysis' range holds. From its state where
    // the state has one range (the block's controls can lag behind it); from
    // the block for the analyses with a range per fit or per segment.
    const RANGE_STATE = { fft: 'fft', histogram: 'histogram', heatmap: 'heatmap', 'temporal-profile': 'temporalProfile',
        integral: 'integral', correlation: 'correlation', phase2d: 'phase2d' };
    B.fraction = (id) => {
        const range = B.range(id);
        if (!range || !(range.max > range.min)) return null;
        const state = pm.plots.get(id)?.[RANGE_STATE[pm.plots.get(id)?.mode]];
        if (state && typeof state.rangeFull === 'boolean') {
            if (state.rangeFull) return 1;
            if (Number.isFinite(state.x1) && Number.isFinite(state.x2)) return Math.abs(state.x2 - state.x1) / (range.max - range.min);
        }
        if (range.full) return 1;
        return Math.abs(range.x2 - range.x1) / (range.max - range.min);
    };
    B.selectionMode = (id) => {
        const range = B.range(id);
        if (range?.full) panelEl(id).querySelector('[data-analysis-range-full="false"]').click();
    };
    B.typeBound = (id, key, fraction) => {
        const range = B.range(id);
        const field = control(id, key, 'input');
        const value = range.min + (range.max - range.min) * fraction;
        field.value = range.calendar ? new Date(value).toISOString().slice(0, 19) : String(value);
        field.dispatchEvent(new Event('change'));
        return value;
    };
    // A drag of the slider: `steps` moves 16 ms apart, then let go.
    B.dragBound = async (id, key, fromFraction, toFraction, steps = 20) => {
        const range = B.range(id);
        const slider = control(id, key, 'slider');
        const at = fraction => range.min + (range.max - range.min) * fraction;
        let maxDelay = 0;
        const startedAt = now();
        for (let k = 1; k <= steps; k++) {
            const before = now();
            await new Promise(resolve => setTimeout(resolve, 16));
            maxDelay = Math.max(maxDelay, now() - before - 16);
            // The panel may have been rebuilt under the drag.
            const live = control(id, key, 'slider') || slider;
            live.value = String(at(fromFraction + ((toFraction - fromFraction) * k) / steps));
            live.dispatchEvent(new Event('input'));
        }
        const releasedAt = now();
        B.slow = false;
        B.slowUntil = releasedAt + 1000;
        (control(id, key, 'slider') || slider).dispatchEvent(new Event('change'));
        return { startedAt, releasedAt, maxDelay };
    };

    // Is the panel's analysis still working?
    const RUN_SLOTS = ['_histRecomputeRun', '_calendarHeatmapRecomputeRun', '_temporalProfileRecomputeRun',
        '_integralRecomputeRun', '_correlationRecomputeRun', '_phase2dFitRecomputeRun', '_curveFitRecomputeRun', '_trendRecomputeRun'];
    B.busy = (id) => {
        const plot = pm.plots.get(id);
        if (!plot) return false;
        if (plot._analysisPill) return true;
        if (RUN_SLOTS.some(key => plot[key])) return true;
        if (pm._analysisSettled && !pm._analysisSettled(plot)) return true;
        if (panelEl(id)?.querySelector('.lazy-detail-indicator.active:not(.analysis-computing-indicator)')) return true;
        return false;
    };
    // Wait for the result of what was asked at `since`: the pill came on and
    // went off (and stayed off), or it never came on and something was drawn.
    // Resolves to { resultAt, pill } in the page's clock.
    B.waitResult = (id, since, { appearMs = 1500, quietMs = 400, timeoutMs = 600000 } = {}) => new Promise((resolve) => {
        let sawBusy = false;
        let idleSince = null;
        const check = () => {
            const t = now();
            if (B.busy(id)) {
                sawBusy = true;
                idleSince = null;
            } else {
                if (idleSince === null) idleSince = t;
                const transitions = B.pill.filter(entry => entry.panelId === id && entry.t >= since);
                const pill = sawBusy || transitions.some(entry => entry.on);
                const lastOff = [...transitions].reverse().find(entry => !entry.on)?.t ?? null;
                if (pill && t - idleSince >= quietMs) return resolve({ resultAt: lastOff ?? idleSince, pill: true });
                if (!pill && t - since >= appearMs) {
                    const drawn = B.plotly.filter(call => call.start >= since).map(call => call.end);
                    return resolve({ resultAt: drawn.length ? Math.max(...drawn) : NaN, pill: false });
                }
            }
            if (t - since > timeoutMs) return resolve({ resultAt: NaN, pill: sawBusy, timeout: true });
            return setTimeout(check, 25);
        };
        check();
    });
    // Wait until `test()` holds; resolves to the page time it first did.
    B.waitFor = (test, { timeoutMs = 600000 } = {}) => new Promise((resolve) => {
        const started = now();
        const check = () => {
            let ok = false;
            try { ok = !!test(); } catch (_) { ok = false; }
            if (ok) return resolve({ resultAt: now() });
            if (now() - started > timeoutMs) return resolve({ resultAt: NaN, timeout: true });
            setTimeout(check, 20);
        };
        check();
    });
    B.warnings = (id) => {
        const plot = pm.plots.get(id);
        const warnings = plot?.[RANGE_STATE[plot?.mode]]?.warnings;
        return Array.isArray(warnings) ? warnings.map(text => String(text).replace(/\s+/g, ' ').trim().slice(0, 200)) : [];
    };
    B.status = (id) => {
        const el = panelEl(id)?.querySelector('.fft-status, .hist-status, .heatmap-status');
        return (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    };
    B.pillOn = id => !!panelEl(id)?.querySelector('.analysis-computing-indicator.active .analysis-cancel-btn');
    B.inFlight = since => B.queries.some(entry => entry.start >= since && entry.end === null);
}

// ─── Measuring one action ─────────────────────────────────────────────────

const round = value => (Number.isFinite(value) ? Math.round(value) : null);

function overlap(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function shortUrl(url) {
    if (!url) return '';
    const clean = String(url).split('?')[0];
    const src = clean.indexOf('/src/');
    if (src >= 0) return clean.slice(src + 1);
    const modules = clean.indexOf('/node_modules/');
    if (modules >= 0) return clean.slice(modules + 14).split('/').slice(0, 2).join('/');
    return clean.split('/').slice(-1)[0];
}

// A CPU profile (CDP Profiler.stop), ready to be asked what ran in a window
// of the page's clock. `offsetUs` is the profile clock at performance.now()=0.
//
// Each sample is one of three things:
//   plotly   a Plotly function is on the stack: building and drawing a chart;
//   render   no JavaScript is running — "(program)" at the root: style,
//            layout, and the compositor's commit, where a WebGL canvas drawn
//            in software is handed over;
//   compute  everything else: the app's own code, Arrow, the garbage collector.
function indexProfile(profile, offsetUs) {
    const byId = new Map();
    const parent = new Map();
    for (const node of profile.nodes || []) {
        byId.set(node.id, node);
        for (const child of node.children || []) parent.set(child, node.id);
    }
    const frameKey = (node) => {
        const frame = node.callFrame || {};
        const name = frame.functionName || '(anonymous)';
        const where = shortUrl(frame.url);
        return where ? `${name} (${where}:${(frame.lineNumber ?? 0) + 1})` : name;
    };
    const info = new Map();
    const resolve = (id) => {
        if (info.has(id)) return info.get(id);
        const node = byId.get(id);
        const up = parent.has(id) ? resolve(parent.get(id)) : { plotly: false, js: false, app: [] };
        const url = node?.callFrame?.url || '';
        const name = node?.callFrame?.functionName || '';
        const pseudo = /^\((root|program|idle|garbage collector)\)$/.test(name);
        const out = {
            plotly: up.plotly || /plotly/.test(url),
            js: up.js || (!pseudo && (!!url || !!name)),
            app: /\/src\//.test(url) ? [...up.app, frameKey(node)] : up.app,
            self: frameKey(node),
            name,
        };
        info.set(id, out);
        return out;
    };
    const samples = profile.samples || [];
    const deltas = profile.timeDeltas || [];
    const times = new Float64Array(samples.length);
    let clock = Number(profile.startTime) || 0;
    for (let i = 0; i < samples.length; i++) {
        clock += deltas[i] || 0;
        times[i] = (clock - offsetUs) / 1000;
    }
    const classOf = (entry) => {
        if (entry.plotly) return 'plotly';
        if (!entry.js && (entry.name === '(program)' || entry.name === '(idle)')) return 'render';
        return 'compute';
    };
    // What ran between t0 and t1 (ms, page clock).
    return (t0, t1, { top = 8 } = {}) => {
        let lo = 0;
        let hi = times.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (times[mid] < t0) lo = mid + 1; else hi = mid;
        }
        const sum = { plotly: 0, render: 0, compute: 0 };
        const inclusive = new Map();
        const self = new Map();
        const chains = new Map();
        for (let i = lo; i < times.length && times[i] < t1; i++) {
            const weight = Math.min(i + 1 < times.length ? times[i + 1] : t1, t1) - times[i];
            if (!(weight > 0)) continue;
            const entry = resolve(samples[i]);
            const kind = classOf(entry);
            sum[kind] += weight;
            if (kind !== 'compute') continue;
            self.set(entry.self, (self.get(entry.self) || 0) + weight);
            for (const key of new Set(entry.app)) inclusive.set(key, (inclusive.get(key) || 0) + weight);
            chains.set(entry.app, (chains.get(entry.app) || 0) + weight);
        }
        // The chain of app functions most of the time was spent under: the
        // heaviest stack, cut where the time under it thins out.
        const [heaviest] = [...chains.entries()].sort((a, b) => b[1] - a[1])[0] || [[]];
        const path = [];
        for (const key of heaviest) {
            if (path.includes(key)) continue;
            if ((inclusive.get(key) || 0) < sum.compute * 0.25) break;
            path.push(key);
        }
        const rank = map => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
            .map(([name, ms]) => ({ name, ms: Math.round(ms) }))
            .filter(item => item.ms >= Math.max(5, sum.compute * 0.04));
        return { ...sum, sampled: sum.plotly + sum.render + sum.compute, app: rank(inclusive), self: rank(self), path };
    };
}

// The record of one action, from the logs between `since` and `until`.
// `ran(t0, t1)` is the profile, when there is one.
function summarize(logs, since, until, ran = null) {
    const tasks = logs.long
        .filter(task => task.start + task.duration > since && task.start < until)
        .map((task) => {
            const end = task.start + task.duration;
            if (ran) {
                const split = ran(task.start, end);
                // What the sampler did not see of a task is counted as computation.
                const plotly = Math.min(task.duration, split.plotly);
                const render = Math.min(task.duration - plotly, split.render);
                return { start: task.start, at: task.start - since, duration: task.duration, plotly, render, compute: Math.max(0, task.duration - plotly - render), split };
            }
            // Without a profile: the synchronous part of each Plotly call.
            const plotly = Math.min(task.duration, logs.plotly.reduce((sum, call) => sum + overlap(task.start, end, call.start, call.end), 0));
            return { start: task.start, at: task.start - since, duration: task.duration, plotly, render: null, compute: Math.max(0, task.duration - plotly), split: null };
        });
    const max = (values) => (values.length ? Math.max(...values) : 0);
    const gaps = entries => max(entries.filter(entry => entry.end > since && entry.end - entry.gap < until).map(entry => entry.gap));
    const worst = [...tasks].sort((a, b) => b.compute - a.compute)[0] || null;
    const out = {
        longest: round(max(tasks.map(task => task.duration))),
        longestCompute: round(max(tasks.map(task => task.compute))),
        longestPlotly: round(max(tasks.map(task => task.plotly))),
        longestRender: ran ? round(max(tasks.map(task => task.render))) : null,
        tasksOver50: tasks.length,
        blocked: round(tasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0)),
        // What a frame, or a 10 ms timer, waited beyond its own period.
        rafGap: round(Math.max(0, gaps(logs.raf) - 17)),
        timerGap: round(Math.max(0, gaps(logs.timer) - 10)),
        tasks: tasks.filter(task => task.duration >= 100).map(task => ({
            at: round(task.at), ms: round(task.duration), compute: round(task.compute), plotly: round(task.plotly), render: round(task.render),
        })),
        queries: logs.queries.filter(entry => entry.start >= since).map(entry => ({
            kind: entry.kind, ms: entry.end === null ? null : round(entry.end - entry.start), outcome: entry.outcome,
            signal: entry.signal, chunks: entry.chunks || undefined, sql: entry.sql,
        })),
        workers: logs.workers.filter(worker => worker.created >= since || (worker.lastPost !== null && worker.lastPost >= since))
            .map(worker => ({ url: worker.url, terminated: worker.terminated !== null && worker.terminated >= since })),
    };
    // The functions behind the task with the most computation, when it is
    // over the limit: the app's, by the time in them and in what they call,
    // and whatever was actually running (self time).
    if (worst?.split && worst.compute > LIMIT_MS) {
        out.attribution = {
            taskMs: round(worst.duration), computeMs: round(worst.compute), at: round(worst.at),
            path: worst.split.path, app: worst.split.app, self: worst.split.self,
        };
    }
    return out;
}

// ─── The run ──────────────────────────────────────────────────────────────

const results = [];
const notes = [];

const environment = { range: [RANGE_LO, RANGE_HI], date: new Date().toISOString(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model || '', memoryGb: Math.round(os.totalmem() / 2 ** 30), browser: '' };

function save() {
    if (args.out) fs.writeFileSync(args.out, JSON.stringify({ limitMs: LIMIT_MS, profiled: PROFILE, environment, results, notes }, null, 2));
}

function record(row) {
    results.push(row);
    save();
    const flag = (value) => (value !== null && value > LIMIT_MS ? '!' : ' ');
    const parts = [
        `${row.analysis} · ${row.rows} · ${row.mode} · ${row.action}${row.param ? ` (${row.param})` : ''}:`,
        row.error ? `ERROR ${row.error}` : '',
        row.longestCompute !== undefined ? `compute ${row.longestCompute} ms${flag(row.longestCompute)}` : '',
        row.longestPlotly !== undefined ? `plotly ${row.longestPlotly} ms` : '',
        row.longestRender !== undefined && row.longestRender !== null ? `render ${row.longestRender} ms` : '',
        row.longest !== undefined ? `longest ${row.longest} ms${flag(row.longest)}` : '',
        row.rafGap !== undefined ? `frame gap ${row.rafGap} ms, timer gap ${row.timerGap} ms` : '',
        row.ttr !== undefined ? `${row.action === 'cancel' ? 'stopped' : 'result'} in ${row.ttr === null ? '—' : `${row.ttr} ms`}` : '',
        row.supersede ? `newer request: ${row.supersede}` : '',
        row.cancel ? `cancel: ${row.cancel}` : '',
        row.note ? `[${row.note}]` : '',
        row.status ? `«${row.status.slice(0, 70)}»` : '',
        row.warnings?.length ? `warnings: ${row.warnings.map(text => text.slice(0, 110)).join(' | ')}` : '',
    ].filter(Boolean);
    console.log(parts.join('  '));
    if (row.attribution) {
        console.log(`    the task of ${row.attribution.taskMs} ms, ${row.attribution.computeMs} ms of it computation:`);
        if (row.attribution.path?.length) console.log(`        path  ${row.attribution.path.join(' → ')}`);
        for (const item of row.attribution.app) console.log(`        app   ${String(item.ms).padStart(6)} ms  ${item.name}`);
        for (const item of row.attribution.self) console.log(`        self  ${String(item.ms).padStart(6)} ms  ${item.name}`);
    }
}

// ─── The tables ───────────────────────────────────────────────────────────

const mark = value => (value === null || value === undefined ? '—' : (value > LIMIT_MS ? `**${value}**` : String(value)));
const plain = value => (value === null || value === undefined ? '—' : String(value));

// What a row has to say beyond its numbers.
function rowNotes(row) {
    const said = [row.status || '', ...(row.action === 'open' || row.action === 'type' ? row.warnings || [] : [])]
        .filter(text => /too |cannot|could not|refus|limit|error|fail|no calendar|not |only /i.test(text) && !/see the message/i.test(text));
    return [
        row.error ? `error: ${row.error}` : '',
        row.cancel || '',
        row.note || '',
        row.fraction !== null && row.fraction !== undefined && row.fraction < 0.999 && row.action === 'open' ? `range: ${Math.round(row.fraction * 100)} % of the file` : '',
        row.dragDelay !== undefined && row.dragDelay !== null ? `slider events waited ≤ ${row.dragDelay} ms` : '',
        said.length ? `the app says: “${said[0].slice(0, 140)}”` : '',
    ].filter(Boolean).join('; ').replace(/\|/g, '/');
}

const actionName = row => (row.param ? `${row.action}: ${row.param}` : row.action);

// One table, a row per action, in the order they ran.
function markdown(rows) {
    const lines = [
        '| Analysis | Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |',
        '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const row of rows) {
        lines.push(`| ${row.label || row.analysis} | ${(row.rows / 1e6).toFixed(1)} M | ${row.mode} | ${actionName(row)} | ${mark(row.longestCompute)} | ${plain(row.longestPlotly)} | ${plain(row.longestRender)} | ${mark(row.longest)} | ${plain(row.rafGap)} | ${plain(row.ttr)} | ${row.supersede || ''} | ${rowNotes(row)} |`);
    }
    return lines.join('\n');
}

// The runs of several --out files as one document: a table per analysis, and
// under it the functions behind each task whose computation is over the limit.
function report(runs) {
    const rows = runs.flatMap(run => run.results || []);
    const out = [];
    for (const id of ALL_IDS) {
        const mine = rows.filter(row => row.analysis === id);
        if (!mine.length) continue;
        mine.sort((a, b) => (a.rows - b.rows) || (a.mode === b.mode ? 0 : (a.mode === 'lazy' ? -1 : 1)));
        out.push(`### ${mine[0].label || id}`, '');
        out.push('| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |');
        out.push('|---|---|---|---|---|---|---|---|---|---|---|');
        for (const row of mine) {
            out.push(`| ${(row.rows / 1e6).toFixed(1)} M | ${row.mode} | ${actionName(row)} | ${mark(row.longestCompute)} | ${plain(row.longestPlotly)} | ${plain(row.longestRender)} | ${mark(row.longest)} | ${plain(row.rafGap)} | ${plain(row.ttr)} | ${row.supersede || ''} | ${rowNotes(row)} |`);
        }
        out.push('');
        // One line per file, mode and culprit: the action that held the
        // thread longest for each function found running.
        const worstBy = new Map();
        for (const row of mine.filter(item => item.attribution)) {
            const key = `${row.rows}|${row.mode}|${row.attribution.self[0]?.name || ''}`;
            if (!worstBy.has(key) || worstBy.get(key).attribution.computeMs < row.attribution.computeMs) worstBy.set(key, row);
        }
        const held = mine.filter(row => worstBy.get(`${row.rows}|${row.mode}|${row.attribution?.self[0]?.name || ''}`) === row);
        if (held.length) {
            // The task with the most computation, from the CPU profile: the
            // app functions the time was spent under, outermost first, and
            // the code that was running (self time).
            out.push('What held the thread:', '');
            for (const row of held) {
                const where = `${(row.rows / 1e6).toFixed(1)} M, ${row.mode}, ${actionName(row)}`;
                // The app's functions by the time under them: the call chain, outermost first.
                const chain = (row.attribution.path?.length ? row.attribution.path : row.attribution.app.map(item => item.name))
                    .filter(name => !/^\(anonymous\)/.test(name)).map(name => `\`${name}\``).join(' → ');
                const self = row.attribution.self.slice(0, 4).map(item => `\`${item.name}\` ${item.ms} ms`).join(', ');
                out.push(`- **${where}**: a task of ${row.attribution.taskMs} ms, ${row.attribution.computeMs} ms of it computation. Under ${chain || '—'}. Self: ${self || '—'}.`);
            }
            out.push('');
        }
    }
    const said = [...new Set(runs.flatMap(run => run.notes || []))];
    if (said.length) out.push('Notes of the runs:', '', ...said.map(note => `- ${note}`), '');
    return out.join('\n');
}

// --report=a.json,b.json: the tables of earlier runs (their --out files), and
// nothing is run.
if (args.report) {
    console.log(report(list(args.report, []).map(file => JSON.parse(fs.readFileSync(file, 'utf8')))));
    process.exit(0);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch({ headless: !HEADED, args: ['--autoplay-policy=no-user-gesture-required'] });
environment.browser = `Chromium ${browser.version()}${HEADED ? '' : ' (headless)'}`;
console.log(`${environment.browser}, ${environment.cpus} × ${environment.cpu}, ${environment.memoryGb} GB`);

async function withTimeout(promise, ms, what) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${what}`)), ms); });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

// One file in one loading mode: a page of its own.
async function openFile(kind, rows, mode) {
    const file = ensureCsv(kind, rows);
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(initScript);
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 120000 });
    // Lazy: a 2 MB limit. Eager: no limit (0), whatever the size.
    await page.evaluate(mb => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: mb }), mode === 'lazy' ? 2 : 0);
    const started = Date.now();
    await page.setInputFiles('#file-input', file);
    await page.waitForFunction(() => {
        const data = [...window.app.plotManager.files.values()][0]?.data;
        return !!data?.variables?.a && !document.getElementById('file-loading-overlay');
    }, null, { timeout: 900000, polling: 250 });
    const loaded = await page.evaluate(() => {
        const data = [...window.app.plotManager.files.values()][0].data;
        return { lazy: !!data._duckdb, inMemory: data.variables.a.data?.length || 0, rows: data.metadata?.numTimesteps || 0 };
    });
    const loadMs = Date.now() - started;
    const actualMode = loaded.lazy ? 'lazy' : 'eager';
    console.log(`\n── ${kind} time axis, ${rows} rows, ${mode}: loaded in ${loadMs} ms (${actualMode}, ${loaded.inMemory} values of "a" in memory) ──`);
    if (actualMode !== mode) notes.push(`${kind} ${rows}: asked for ${mode}, the app opened it ${actualMode}`);
    await page.evaluate(installBench);
    // The profiler, and where its clock stands against performance.now():
    // NavigationStart is the page's time origin on the profile's clock.
    let cdp = null;
    let offsetUs = NaN;
    if (PROFILE) {
        cdp = await context.newCDPSession(page);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
        await cdp.send('Performance.enable');
        const { metrics } = await cdp.send('Performance.getMetrics');
        offsetUs = (metrics.find(metric => metric.name === 'NavigationStart')?.value ?? NaN) * 1e6;
        // Checked once: a 60 ms loop of a known name must be where the clock
        // says it is.
        await cdp.send('Profiler.start');
        await page.waitForTimeout(1200);
        const marker = await page.evaluate(() => {
            const spin = function benchClockMarker() {
                const start = performance.now();
                let x = 0;
                while (performance.now() - start < 60) {
                    for (let i = 0; i < 20000; i++) x = (x * 1.0000001 + i) % 1e9;
                }
                return [start, performance.now(), x];
            };
            return spin();
        });
        const { profile } = await cdp.send('Profiler.stop');
        const ran = indexProfile(profile, offsetUs)(marker[0], marker[1]);
        const hit = ran.self.find(item => /benchClockMarker/.test(item.name))?.ms || 0;
        if (!(hit >= 40)) {
            notes.push(`${kind} ${rows} ${mode}: the profile's clock could not be matched (${hit} ms of a 60 ms marker); measured without it`);
            cdp = null;
        }
    }
    const timeId = await page.evaluate(() => {
        window.app.setActiveFile([...window.app.plotManager.files.keys()][0]);
        return document.querySelector('.layout-panel').dataset.id;
    });
    return { page, context, errors, cdp, offsetUs, kind, rows, mode: actualMode, timeId };
}

// Before an action: the profiler started (which itself holds the thread for
// a moment, while V8 lists the code it knows), and the logs emptied.
async function beginAction(session) {
    if (session.cdp) {
        await session.cdp.send('Profiler.start');
        await session.page.waitForTimeout(900);
    }
    await session.page.evaluate(() => window.__bench.reset());
}

// After it: the logs and the profile, as the row's numbers.
async function finishAction(session, row, from, until = null) {
    const logs = await session.page.evaluate(() => window.__bench.collect());
    let ran = null;
    if (session.cdp) {
        const { profile } = await session.cdp.send('Profiler.stop');
        ran = indexProfile(profile, session.offsetUs);
    }
    Object.assign(row, summarize(logs, from, until ?? logs.now, ran));
    return logs;
}

async function abandonAction(session) {
    if (!session.cdp) return;
    try { await session.cdp.send('Profiler.stop'); } catch (_) { /* not started */ }
}

// Run `act` in the page and measure until its result. `act` is a function
// body with (B, pm, id, plot, since) that returns nothing or a promise; `wait`
// is a function body that resolves to { resultAt } (default: the pill).
async function measure(session, base, { id, act, wait = null, tailMs = 500, extra = null, keep = true }) {
    const { page } = session;
    const row = { ...base };
    try {
        await beginAction(session);
        const outcome = await withTimeout(page.evaluate(async ({ id, act, wait, timeoutMs }) => {
            const B = window.__bench;
            const pm = window.app.plotManager;
            const plot = pm.plots.get(id);
            const since = performance.now();
            // eslint-disable-next-line no-new-func
            const detail = await new Function('B', 'pm', 'id', 'plot', 'since', `return (async () => { ${act} })();`)(B, pm, id, plot, since);
            const from = detail?.from ?? since;
            // eslint-disable-next-line no-new-func
            const result = wait
                ? await new Function('B', 'pm', 'id', 'plot', 'since', `return (async () => { ${wait} })();`)(B, pm, id, pm.plots.get(id), from)
                : await B.waitResult(id, from, { timeoutMs });
            return { since, from, detail: detail || null, result };
        }, { id, act, wait, timeoutMs: ACTION_TIMEOUT_MS - 10000 }), ACTION_TIMEOUT_MS, `${base.analysis} ${base.action}`);
        await page.waitForTimeout(tailMs);
        const { from, result, detail } = outcome;
        const logs = await finishAction(session, row, from, Number.isFinite(result.resultAt) ? result.resultAt + tailMs : null);
        row.ttr = Number.isFinite(result.resultAt) ? round(result.resultAt - from) : null;
        if (result.timeout) row.note = [row.note, 'timed out'].filter(Boolean).join('; ');
        if (result.pill === false) row.note = [row.note, 'no computing pill'].filter(Boolean).join('; ');
        const after = await page.evaluate((id) => ({ status: window.__bench.status(id), fraction: window.__bench.fraction(id), warnings: window.__bench.warnings(id) }), id);
        row.status = after.status;
        if (after.warnings.length) row.warnings = after.warnings;
        row.fraction = after.fraction === null ? null : Math.round(after.fraction * 1000) / 1000;
        if (extra) Object.assign(row, extra({ logs, from, detail, result, outcome }) || {});
    } catch (error) {
        row.error = String(error?.message || error).split('\n')[0].slice(0, 200);
        await abandonAction(session);
    }
    // `keep: false`: a step on the way to what is measured.
    if (keep) record(row);
    return row;
}

// Nothing measured: get to a known state and let it settle.
async function prepare(session, id, body) {
    await session.page.evaluate(async ({ id, body }) => {
        const B = window.__bench;
        const pm = window.app.plotManager;
        const since = performance.now();
        // eslint-disable-next-line no-new-func
        await new Function('B', 'pm', 'id', 'plot', `return (async () => { ${body} })();`)(B, pm, id, pm.plots.get(id));
        await B.waitResult(id, since, { appearMs: 700 });
    }, { id, body });
    await session.page.waitForTimeout(300);
}

// Stopped before its end: its signal aborted while it ran (DuckDB's interrupt
// then surfaces as an AbortError or as its own error), or its consumer closed
// the stream.
const stopped = entry => entry.abortedAt !== null || entry.outcome === 'AbortError' || entry.outcome === 'closed';

// What became of what the superseded request had started when the newer one
// was asked for (the release of the slider).
function supersedeVerdict(mode, { logs, detail }) {
    const released = detail.releasedAt;
    if (mode === 'eager') {
        const workers = logs.workers.filter(worker => worker.lastPost !== null && worker.lastPost >= detail.typedAt && worker.lastPost < released);
        if (workers.some(worker => worker.terminated !== null)) return 'yes: its worker is terminated';
        if (workers.length) return 'no: its worker ran on';
        // No worker was at work on the older request. Either it had not started
        // (a fit starts on the release of the slider), or it ran on the main
        // thread, and then the delay says for how long.
        if (detail.maxDelay > 100) return `nothing in a worker; the main thread was held ${round(detail.maxDelay)} ms`;
        return 'nothing in flight';
    }
    const older = logs.queries.filter(entry => entry.start >= detail.typedAt && entry.start < released);
    const open = older.filter(entry => entry.end === null || entry.end > released);
    const unsignalled = older.filter(entry => !entry.signal).length;
    if (!open.length) {
        if (!older.length) return 'nothing in flight';
        return unsignalled ? `nothing in flight (${unsignalled} of its ${older.length} reads carry no signal)` : 'nothing in flight (done before the release)';
    }
    const ranOn = open.filter(entry => !stopped(entry));
    if (!ranOn.length) {
        // When the abort came after the release, and how long the read took to end.
        const abortedAfter = Math.max(...open.map(entry => (entry.abortedAt ?? entry.end ?? logs.now) - released));
        const endedAfter = Math.max(...open.map(entry => (entry.end ?? logs.now) - (entry.abortedAt ?? entry.end ?? logs.now)));
        return `yes: aborted ${round(Math.max(0, abortedAfter))} ms after, ended ${round(Math.max(0, endedAfter))} ms later`;
    }
    return `no: ${ranOn.length} of ${open.length} read${open.length === 1 ? '' : 's'} ran to ${ranOn.length === 1 ? 'its' : 'their'} end${ranOn.every(entry => !entry.signal) ? ' (no signal)' : ''}`;
}

// The five actions on an analysis that has the shared range block.
async function runRangeAnalysis(session, analysis, id, open) {
    const base = { analysis: analysis.id, label: analysis.label, rows: session.rows, mode: session.mode, file: session.kind };
    const want = action => ACTIONS.includes(action);

    const opened = await measure(session, { ...base, action: 'open' }, { id, act: open });
    if (opened.error) return;
    if (analysis.afterOpen) await prepare(session, id, analysis.afterOpen);
    // Selection, not Full: so that typing the bounds is one recompute.
    await prepare(session, id, 'B.selectionMode(id);');
    const hasRange = await session.page.evaluate(id => !!window.__bench.range(id), id);
    if (!hasRange) {
        notes.push(`${analysis.id} (${session.rows}, ${session.mode}): no range block found`);
        return;
    }

    if (want('type') || want('param') || want('drag') || want('cancel')) {
        await measure(session, { ...base, action: 'type' }, {
            id, act: `B.typeBound(id, 'x1', ${RANGE_LO}); B.typeBound(id, 'x2', ${RANGE_HI});`,
        });
    }
    if (want('param')) {
        for (const param of analysis.params || []) {
            await measure(session, { ...base, action: 'param', param: param.name }, { id, act: param.run });
            if (param.after) await prepare(session, id, param.after);
        }
    }
    if (want('drag')) {
        // A bound is typed; once its recompute is in flight the same bound is
        // dragged to 40 % and let go. Measured from the release.
        await measure(session, { ...base, action: 'drag' }, {
            id,
            act: `
                const lazy = [...pm.files.values()].some(file => file?.data?._duckdb);
                B.slow = lazy;
                B.slowUntil = Infinity;
                const typedAt = performance.now();
                B.typeBound(id, 'x1', 0.05);
                // A lazy file: the drag begins once the read is under way. A
                // file in memory: at once — its recompute starts under the drag
                // (debounce, a frame, then the kernel), and holds it if it is
                // synchronous.
                if (lazy) await B.waitFor(() => B.inFlight(typedAt), { timeoutMs: 3000 });
                const inFlight = lazy ? B.inFlight(typedAt) : true;
                const drag = await B.dragBound(id, 'x1', 0.05, 0.4, lazy ? 20 : 40);
                return { from: drag.releasedAt, typedAt, inFlight, ...drag };
            `,
            extra: ({ logs, detail }) => ({
                dragDelay: round(detail.maxDelay),
                supersede: supersedeVerdict(session.mode, { logs, detail }),
                note: detail.inFlight ? '' : 'the typed range was not in flight when the drag began',
            }),
        });
        await session.page.evaluate(() => { window.__bench.slow = false; window.__bench.slowUntil = 0; });
    }
    if (want('cancel')) await runCancel(session, base, id);
}

// A recompute is asked for, and Cancel pressed on the pill with the mouse.
// "Time to result" is, here, how long the press waited for the page to take it.
async function runCancel(session, base, id) {
    const { page } = session;
    const row = { ...base, action: 'cancel' };
    try {
        await beginAction(session);
        const before = await page.evaluate(id => ({ range: window.__bench.range(id) }), id);
        const typedAt = await page.evaluate((id) => {
            const B = window.__bench;
            const at = performance.now();
            B.typeBound(id, 'x1', 0.15);
            B.typeBound(id, 'x2', 0.85);
            return at;
        }, id);
        // The pill, and where its button is.
        const box = await withTimeout(page.evaluate(async ({ id, typedAt }) => {
            const B = window.__bench;
            await B.waitFor(() => B.pillOn(id), { timeoutMs: 5000 });
            // On a lazy file: once the read is under way, not before it starts.
            if ([...window.app.plotManager.files.values()].some(file => file?.data?._duckdb)) {
                await B.waitFor(() => B.inFlight(typedAt) || !B.pillOn(id), { timeoutMs: 3000 });
                await new Promise(resolve => setTimeout(resolve, 30));
            }
            const button = document.querySelector(`.layout-panel[data-id="${id}"] .analysis-computing-indicator.active .analysis-cancel-btn`);
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, at: performance.now() };
        }, { id, typedAt }), ACTION_TIMEOUT_MS, 'the pill');
        if (!box) {
            const waited = await page.evaluate(({ id, typedAt }) => window.__bench.waitResult(id, typedAt), { id, typedAt });
            await finishAction(session, row, typedAt);
            const after = Number.isFinite(waited.resultAt) ? `, ${round(waited.resultAt - typedAt)} ms after the change` : '';
            // A kernel on the main thread: the pill was drawn, and the page
            // could not be asked where it was until the result had come.
            row.cancel = row.longestCompute > 100
                ? `could not be pressed: the thread was held until the result came${after}`
                : `no pill to press: the result came first${after}`;
            row.ttr = null;
        } else {
            // A real click: it waits its turn behind whatever holds the thread.
            const pressedAt = Date.now();
            await withTimeout(page.mouse.click(box.x, box.y), ACTION_TIMEOUT_MS, 'the click on Cancel');
            const clickTook = Date.now() - pressedAt;
            await page.waitForTimeout(700);
            const after = await page.evaluate((id) => {
                const B = window.__bench;
                const click = B.clicks[B.clicks.length - 1] || null;
                return { click, pill: B.pillOn(id), status: B.status(id), busy: B.busy(id), now: performance.now(), range: B.range(id) };
            }, id);
            const logs = await finishAction(session, row, typedAt);
            const cancelled = /cancel/i.test(after.status);
            const hit = !!after.click?.cancel;
            const mine = logs.queries.filter(entry => entry.start >= typedAt);
            const aborted = mine.filter(stopped).length;
            const open = mine.filter(entry => entry.end === null).length;
            const restored = after.range && before.range
                ? Math.abs(after.range.x1 - before.range.x1) + Math.abs(after.range.x2 - before.range.x2) <= 1e-9 * Math.abs(before.range.max - before.range.min)
                : null;
            row.clickDelay = after.click ? round(after.click.delay) : null;
            row.ttr = hit ? row.clickDelay : null;
            const reads = session.mode === 'lazy' ? `; ${aborted} of ${mine.length} read${mine.length === 1 ? '' : 's'} aborted, ${open} still running` : '';
            const settings = restored === null ? '' : (restored ? '; the range is back' : '; the range is NOT put back');
            row.cancel = hit
                ? `${cancelled ? 'cancelled' : 'pressed, but the status line does not say cancelled'}${reads}${settings}`
                : `too late: the pill was gone when the press landed, ${clickTook} ms after it`;
            row.status = after.status;
            // Whatever is left running ends before the next analysis.
            await page.evaluate(({ id, at }) => window.__bench.waitResult(id, at, { appearMs: 600 }), { id, at: after.now });
        }
    } catch (error) {
        row.error = String(error?.message || error).split('\n')[0].slice(0, 200);
        await abandonAction(session);
    }
    record(row);
}

async function runSession(kind, rows, mode) {
    const timeIds = TIME_ANALYSES.filter(item => item.file === kind && WANTED.has(item.id));
    const pairIds = PAIR_ANALYSES.filter(item => item.file === kind && WANTED.has(item.id));
    const other = OTHER.filter(item => item.file === kind && WANTED.has(item.id)).map(item => item.id);
    if (!timeIds.length && !pairIds.length && !other.length) return;

    const session = await openFile(kind, rows, mode);
    const { page, timeId } = session;
    const base = { rows, mode: session.mode, file: kind };
    try {
        // The plot itself: the signal added to an empty panel.
        await measure(session, { ...base, analysis: 'timeseries', label: OTHER[0].label, action: 'open' }, {
            id: timeId,
            act: `pm.addTrace(id, 'a', document.querySelector('.layout-panel[data-id="' + id + '"]'));`,
            wait: `return B.waitFor(() => { const p = pm.plots.get(id); return p?.div?._fullLayout && (p.div.data || []).some(t => (t.x?.length || 0) > 0) && !B.busy(id); });`,
            keep: other.includes('timeseries'),
        });
        await page.waitForTimeout(1500);

        for (const analysis of timeIds) {
            await runRangeAnalysis(session, analysis, timeId, `pm._toggleTimeseriesAnalysisMode(id, ${JSON.stringify(analysis.mode)});`);
            await page.evaluate(async (id) => {
                const pm = window.app.plotManager;
                const since = performance.now();
                pm._requestModeChange(id, 'timeseries');
                await window.__bench.waitResult(id, since, { appearMs: 800 });
            }, timeId);
            await page.waitForTimeout(500);
        }

        if (other.includes('audio')) await runAudio(session);

        if (pairIds.length || other.includes('phase2d')) {
            // A second panel, as a 2D plot of b → a.
            const twoDId = await page.evaluate((first) => {
                window.app.layoutManager.splitPanel(first, 'h', false);
                return [...document.querySelectorAll('.layout-panel')].map(panel => panel.dataset.id).find(id => id !== first);
            }, timeId);
            await page.evaluate(id => window.app.plotManager._setMode(id, 'phase2d'), twoDId);
            await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.mode === 'phase2d', twoDId);
            await page.waitForTimeout(800);
            await measure(session, { ...base, analysis: 'phase2d', label: OTHER[1].label, action: 'open' }, {
                id: twoDId,
                act: `const el = document.querySelector('.layout-panel[data-id="' + id + '"]'); pm.addTrace(id, 'b', el); pm.addTrace(id, 'a', el);`,
                // Drawn, and on a lazy file the trajectory read from it.
                wait: `
                    const found = await B.waitFor(() => pm.plots.get(id)?.phaseTraces?.length > 0 && !B.busy(id)
                        && (pm.plots.get(id).div?.data || []).some(t => t.name !== '__origin__' && t.name !== '__hover__' && (t.x?.length || 0) > 1));
                    if (!Number.isFinite(found.resultAt)) return found;
                    await pm._lastLazyPhaseRefresh;
                    return { resultAt: performance.now() };
                `,
                keep: other.includes('phase2d'),
            });
            await page.waitForTimeout(1000);
            for (const analysis of pairIds) {
                await runRangeAnalysis(session, analysis, twoDId,
                    `pm._analysisMenuModel(id, plot).find(entry => entry.key === ${JSON.stringify(analysis.pick)}).run();`);
                // Back to the plain 2D plot.
                await page.evaluate(async (id) => {
                    const pm = window.app.plotManager;
                    const since = performance.now();
                    pm._analysisMenuModel(id, pm.plots.get(id)).find(entry => entry.key === 'phase2d').run();
                    await window.__bench.waitResult(id, since, { appearMs: 800 });
                }, twoDId);
                await page.waitForTimeout(800);
            }
        }

        if (other.includes('xcorr')) await runXcorr(session);
    } finally {
        if (session.errors.length) notes.push(`${kind} ${rows} ${session.mode}: page errors: ${[...new Set(session.errors)].slice(0, 5).join(' | ')}`);
        await session.context.close();
    }
}

// The audio strip: open it and press Play over the whole signal.
async function runAudio(session) {
    const { page, timeId: id } = session;
    const base = { analysis: 'audio', label: OTHER[3].label, rows: session.rows, mode: session.mode, file: session.kind };
    const playable = await page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        if (!pm._ensureAudioState(plot).open) pm._toggleAudioStrip(id);
        const source = pm._audioSelectedSource(plot);
        return { ok: !!source?.status?.ok, reason: source?.status?.reason || '' };
    }, id);
    await page.waitForTimeout(500);
    if (!playable.ok) {
        record({ ...base, action: 'open', error: `not playable: ${playable.reason}` });
        return;
    }
    await measure(session, { ...base, action: 'open' }, {
        id,
        act: `pm._audioTogglePlay(id);`,
        wait: `return B.waitFor(() => { const s = plot.audio; return !s.loading && (pm._audioPanelIsPlaying(plot) || !!s.notice); });`,
    });
    const state = await page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const out = { playing: pm._audioPanelIsPlaying(plot), frames: plot.audio.buffer?.buffer?.length ?? null,
            note: document.querySelector(`.layout-panel[data-id="${id}"] .audio-strip-note`)?.textContent || '' };
        pm._audioStop(id);
        return out;
    }, id);
    results[results.length - 1].note = `${state.playing ? 'playing' : 'not playing'}, ${state.frames ?? 0} frames${state.note ? `; ${state.note.slice(0, 80)}` : ''}`;
    if (ACTIONS.includes('cancel') && session.mode === 'lazy') {
        // A read under way, and the strip's own cancel (a zoom changes the key).
        await measure(session, { ...base, action: 'cancel' }, {
            id,
            act: `
                plot.audio.buffer = null; plot.audio.bufferKey = ''; plot.audio.prepared = null;
                pm._audioTogglePlay(id);
                await B.waitFor(() => !!plot.audio.loading && B.inFlight(since), { timeoutMs: 5000 });
                await new Promise(resolve => setTimeout(resolve, 300));
                const at = performance.now();
                pm._audioCancelLoad(id);
                return { cancelledAt: at };
            `,
            wait: `return B.waitFor(() => !plot.audio.loading && !B.inFlight(since));`,
            extra: ({ logs, detail, from }) => {
                const mine = logs.queries.filter(entry => entry.start >= from);
                const ended = mine.filter(stopped);
                const after = Math.max(0, ...ended.map(entry => entry.end - detail.cancelledAt));
                return { cancel: ended.length ? `read stopped ${round(after)} ms after` : 'the read was not stopped' };
            },
        });
    }
    await page.evaluate((id) => {
        const pm = window.app.plotManager;
        if (pm._ensureAudioState(pm.plots.get(id)).open) pm._toggleAudioStrip(id);
    }, id);
    await page.waitForTimeout(500);
}

// The Cross-correlation data tool: a against b, its default lag range.
async function runXcorr(session) {
    const { page } = session;
    const base = { analysis: 'xcorr', label: OTHER[2].label, rows: session.rows, mode: session.mode, file: session.kind };
    const id = session.timeId;
    // Picking the tool measures the axis; then the form is filled.
    await measure(session, { ...base, action: 'open' }, {
        id,
        act: `
            const select = (elId, value) => { const el = document.getElementById(elId); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
            select('data-tool-select', 'xcorr');
            select('outlier-variable', 'a');
        `,
        wait: `return B.waitFor(() => !/…$/.test(document.getElementById('xcorr-info')?.textContent || ''), { timeoutMs: 120000 });`,
        extra: () => ({ note: 'the tool is picked: its panel measures the time axis' }),
    });
    const ready = await page.evaluate(() => {
        const select = (elId, value) => { const el = document.getElementById(elId); el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
        select('xcorr-second', 'b');
        // The lag range the tool opens with on a file in memory: a quarter of
        // the record.
        const meta = [...window.app.plotManager.files.values()][0].data.metadata || {};
        const lag = document.getElementById('xcorr-max-lag');
        lag.value = String(Number(((Number(meta.timeEnd) - Number(meta.timeStart)) / 4).toPrecision(3)));
        lag.dispatchEvent(new Event('input', { bubbles: true }));
        lag.dispatchEvent(new Event('change', { bubbles: true }));
        const output = document.getElementById('outlier-output-name');
        output.value = 'xc';
        output.dispatchEvent(new Event('input', { bubbles: true }));
        return {
            lag: document.getElementById('xcorr-max-lag')?.value || '',
            info: document.getElementById('xcorr-info')?.textContent || '',
            disabled: !!document.getElementById('data-tool-create-plot')?.disabled,
            message: document.getElementById('outlier-message')?.textContent || '',
        };
    });
    await page.waitForTimeout(800);
    await measure(session, { ...base, action: 'param', param: `create the dataset (max lag ${ready.lag})` }, {
        id,
        act: `document.getElementById('data-tool-create-plot').click();`,
        wait: `return B.waitFor(() => !window.app._dataToolBusy && !document.getElementById('file-loading-overlay')
            && ([...window.app.files.values()].some(entry => entry.name === 'xc' && entry.derivedDataset)
                || /\\S/.test(document.getElementById('outlier-message')?.textContent || '')), { timeoutMs: 400000 });`,
    });
    const made = await page.evaluate(() => ({
        created: [...window.app.files.values()].some(entry => entry.name === 'xc' && entry.derivedDataset),
        message: (document.getElementById('outlier-message')?.textContent || '').replace(/\s+/g, ' ').slice(0, 140),
    }));
    results[results.length - 1].note = made.created ? 'dataset created' : `not created: ${made.message || ready.message || ready.info}`;
}

try {
    for (const rows of ROWS) {
        for (const mode of MODES) {
            for (const kind of ['numeric', 'calendar']) {
                try {
                    await runSession(kind, rows, mode);
                } catch (error) {
                    notes.push(`${kind} ${rows} ${mode}: ${String(error?.message || error).split('\n')[0]}`);
                    console.error(`session failed (${kind}, ${rows}, ${mode}):`, error?.message || error);
                }
            }
        }
    }
} finally {
    await browser.close();
    await server.close();
}

const table = markdown(results);
save();
if (args.md) fs.writeFileSync(args.md, `${table}\n`);
console.log(`\n${table}\n`);
for (const note of notes) console.log(`note: ${note}`);
