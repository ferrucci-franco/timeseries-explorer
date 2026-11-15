// The Integral analysis on a file in memory-saving (lazy) mode: every row in
// the range, through the in-memory kernel.
//
// In memory, a trace's integral is computeDefiniteIntegral over its
// transformed rows (_getTransformedTimeDataForVariable /
// _getTransformedVariableData: crop, time shift, gain, offset, sign), cut to
// the range with one neighbouring row on each side (_integralSeriesForTrace),
// and each calendar period of "Group by" the same over its own window
// (_integralEagerGroups). Here the very same kernel runs over the file read in
// order, a chunk at a time: the kernel is a sequence of passes
// (definiteIntegralPasses in src/compute/kernels/definite-integral.js), each
// pass here is one stream of the file (streamColumns), and every chunk is
// transformed by the function the other lazy analyses use for rows read from
// the file (_transformFetchedPhaseTrajectory). The rows each kernel is fed are
// the ones the in-memory slice holds — the range and its two neighbours, or a
// period's window and its two — cut on the transformed time by a router
// (createSliceRouter), so the totals and the periods are the in-memory ones,
// bit for bit (scripts/test-lazy-integral.mjs). On any time axis: calendar,
// numeric, or the row number.
//
// Held at any moment: one chunk, and per signal a few numbers — plus, for the
// median sampling step, up to STEP_COLLECT_LIMIT steps before a histogram
// takes over (src/utils/step-median.js).
//
// Streams per file, all signals of the file in each:
//   1. scan — the extent, the order of the axis, its steps;
//   2. only when the median step is not settled by the scan (an axis of more
//      than a million steps whose middle bucket holds more than one value):
//      one or two more over the steps;
//   3. only with a whole-day policy or the incomplete-ends trim (calendar
//      axis): the days that hold a hole. 'Discard the day for all signals'
//      waits here until every file has answered, so all bars share the days;
//   4. the quadrature.
// A calendar period inherits the whole range's step (as in memory) and rides
// on the same streams.
//
// No Plotly here: the module runs in Node against DuckDB-WASM in the tests.

import { streamColumns } from '../../data/column-stream.js';
import { definiteIntegralPasses, INTEGRAL_PASS_STAGES } from '../../compute/kernels/definite-integral.js';

// Rows per chunk: small enough that one chunk's transform and kernel work
// stays a short task on the main thread (the stream yields between chunks).
export const INTEGRAL_LAZY_CHUNK_ROWS = 131072;

const STAGE_ORDER = new Map(INTEGRAL_PASS_STAGES.map((stage, index) => [stage, index]));

function abortError() {
    const err = new Error('Integral cancelled');
    err.name = 'AbortError';
    return err;
}

const BEFORE = 0;
const INSIDE = 1;
const DONE = 2;

/**
 * Cuts a stream of rows, in file order, into the slices the in-memory
 * integral reads: for each window [lo, hi] (sorted by lo), the row just before
 * the first row at or after lo, every row up to hi, and the first row past hi
 * — what _integralSeriesForTrace keeps around a range (lowerBound − 1 …
 * upperBound + 1) on a sorted axis.
 *
 * route(time, onRun, onCarry, onDone) for each chunk's (transformed) times:
 *   onRun(k, a, b)  rows a..b−1 of this chunk belong to window k;
 *   onCarry(k)      the last row of the previous chunk belongs to window k,
 *                   ahead of this chunk's rows;
 *   onDone(k)       window k has all its rows.
 */
export function createSliceRouter(windows) {
    const count = windows.length;
    const lo = Float64Array.from(windows, w => w[0]);
    const hi = Float64Array.from(windows, w => w[1]);
    const state = new Uint8Array(count);
    let first = 0;
    let hasPrev = false;
    let finished = 0;
    return {
        get finished() { return finished === count; },
        route(time, onRun, onCarry, onDone) {
            const len = time.length;
            const runStart = new Int32Array(count).fill(-1);
            for (let k = first; k < count; k++) if (state[k] === INSIDE) runStart[k] = 0;
            for (let i = 0; i < len; i++) {
                const t = time[i];
                for (let k = first; k < count; k++) {
                    const s = state[k];
                    if (s === DONE) {
                        if (k === first) first++;
                        continue;
                    }
                    if (s === BEFORE) {
                        if (!(t >= lo[k])) break;
                        if (i > 0) runStart[k] = i - 1;
                        else {
                            if (hasPrev) onCarry(k);
                            runStart[k] = 0;
                        }
                        if (t <= hi[k]) {
                            state[k] = INSIDE;
                            continue;
                        }
                    } else if (!(t > hi[k])) {
                        continue;
                    }
                    // This row is the window's first past hi: its last.
                    state[k] = DONE;
                    finished++;
                    onRun(k, runStart[k], i + 1);
                    runStart[k] = -1;
                    onDone(k);
                }
            }
            for (let k = first; k < count; k++) {
                if (state[k] === INSIDE && runStart[k] >= 0 && runStart[k] < len) onRun(k, runStart[k], len);
            }
            if (len) hasPrev = true;
        },
        // The stream has ended: every window still open has all it will get.
        close(onDone) {
            for (let k = 0; k < count; k++) {
                if (state[k] === DONE) continue;
                state[k] = DONE;
                finished++;
                onDone(k);
            }
        },
    };
}

export function installPlotIntegralLazyMethods(TargetClass) {
    const proto = TargetClass.prototype;

/**
 * The integral of each lazy candidate, and of each of its calendar windows,
 * over every row of its file. `candidates`: { trace, base } as
 * _recomputeIntegral builds them. Resolves to
 *   { byTrace: Map(trace → { result, groups }), holeDays: number[] }
 * — `holeDays` the days the lazy signals hold holes on, for the eager ones'
 * 'discard-day-all' — or rejects with an AbortError when `signal` stops it.
 *
 * options: state, range (display units, null for the whole file),
 * groupWindows (calendarPeriodWindows' windows, or null), eagerHoleDays (the
 * in-memory signals' hole days, for 'discard-day-all'), signal,
 * onProgress({ pass, rows }), chunkRows, collectLimit (tests).
 */
proto._lazyIntegralResults = async function(candidates, options = {}) {
    const {
        state, range = null, groupWindows = null, eagerHoleDays = [], signal = null,
        onProgress = null, chunkRows = INTEGRAL_LAZY_CHUNK_ROWS, collectLimit,
    } = options;
    const shared = { days: null };
    const sharedDays = () => shared.days;
    const files = [];
    const byFile = new Map();
    for (const candidate of candidates) {
        if (!byFile.has(candidate.trace.fileId)) byFile.set(candidate.trace.fileId, []);
        byFile.get(candidate.trace.fileId).push(candidate);
    }
    for (const [fileId, fileCandidates] of byFile) {
        files.push(this._lazyIntegralFile(fileId, fileCandidates, { state, range, groupWindows, sharedDays, collectLimit }));
    }

    let pass = 0;
    let rowsRead = 0;
    const progress = (rows) => onProgress?.({ pass, rows: rowsRead + rows });
    const stream = async (file, stage) => {
        pass++;
        const rows = await this._streamLazyIntegralStage(file, stage, { signal, chunkRows, onRows: progress });
        rowsRead += rows;
    };

    // Every stage before the quadrature, file by file.
    for (const file of files) {
        for (;;) {
            if (signal?.aborted) throw abortError();
            const stage = this._nextLazyIntegralStage(file);
            if (stage === null) break;
            await stream(file, stage);
        }
    }

    // 'Discard the day for all signals': every signal's holes, in memory and
    // lazy, leave every signal's domain.
    const lazyHoleDays = new Set();
    for (const file of files) {
        for (const kernel of file.kernels) {
            if (kernel.window === null && kernel.daysPass) for (const day of kernel.daysPass.holeDays()) lazyHoleDays.add(day);
        }
    }
    shared.days = state?.missingPolicy === 'discard-day-all' ? [...new Set([...eagerHoleDays, ...lazyHoleDays])] : null;
    for (const file of files) {
        for (const kernel of file.kernels) if (kernel.waiting) { kernel.waiting = false; this._advanceLazyIntegralKernel(kernel); }
    }

    // The quadrature.
    for (const file of files) {
        for (;;) {
            if (signal?.aborted) throw abortError();
            const stage = this._nextLazyIntegralStage(file, { area: true });
            if (stage === null) break;
            await stream(file, stage);
        }
    }

    const byTrace = new Map();
    for (const file of files) {
        for (const candidate of file.candidates) {
            const total = file.kernels.find(kernel => kernel.candidate === candidate && kernel.window === null);
            const windows = file.kernels.filter(kernel => kernel.candidate === candidate && kernel.window !== null);
            byTrace.set(candidate.trace, {
                result: total.result,
                groups: groupWindows
                    ? windows.map(kernel => ({ startMs: kernel.window.periodStartMs, endMs: kernel.window.periodEndMs, result: kernel.result }))
                    : null,
            });
        }
    }
    return { byTrace, holeDays: [...lazyHoleDays].sort((a, b) => a - b) };
};

// The kernels of one file: a total per signal and, grouped, one per signal
// and period, with the slices they read.
proto._lazyIntegralFile = function(fileId, candidates, { state, range, groupWindows, sharedDays, collectLimit }) {
    const data = this.files.get(fileId)?.data;
    const timeVar = this._getTimeVar(fileId);
    const byRow = this._isGeneratedIndexTime(fileId, timeVar) || this._isGeneratedFromDetectedTime(fileId, timeVar);
    const names = [...new Set(candidates.map(candidate => candidate.trace.varName))];
    const kernels = [];
    const kernelOptions = (probe) => ({ probe, collectLimit, stepCapacity: 0 });
    for (const candidate of candidates) {
        const kind = candidate.base.kind;
        // The parameters the in-memory pass gives computeDefiniteIntegral.
        const total = this._integralKernelParams(state, { ...candidate, times: null }, range, sharedDays);
        const probe = {};
        const totalKernel = {
            candidate,
            varName: candidate.trace.varName,
            window: null,
            windowIndex: -1,
            gen: definiteIntegralPasses(total.options, kind, true, kernelOptions(probe)),
            probe,
            parent: null,
        };
        kernels.push(totalKernel);
        if (!groupWindows) continue;
        // _integralEagerGroups: each window inherits the whole range's step,
        // in raw units, from the total's result (which reports it in seconds
        // on a calendar axis) — the same round trip, the same double.
        const base = this._integralKernelParams(state, { ...candidate, times: null }, null, sharedDays);
        const toSeconds = kind === 'datetime' ? 1 / 1000 : 1;
        const nominalStep = () => {
            const verdict = probe.verdict;
            if (!verdict?.hasNominalStep || verdict.medianDt == null) return null;
            const seconds = verdict.medianDt * toSeconds;
            return Number.isFinite(seconds) ? seconds * (kind === 'datetime' ? 1000 : 1) : null;
        };
        groupWindows.forEach((periodWindow, windowIndex) => {
            kernels.push({
                candidate,
                varName: candidate.trace.varName,
                window: periodWindow,
                windowIndex,
                gen: definiteIntegralPasses({
                    ...base.options,
                    rangeStart: periodWindow.startMs,
                    rangeEnd: periodWindow.endMs,
                    nominalStep,
                }, kind, true, kernelOptions(null)),
                probe: null,
                parent: probe,
            });
        });
    }
    for (const kernel of kernels) this._advanceLazyIntegralKernel(kernel, true);
    let lo = -Infinity;
    let hi = Infinity;
    if (range) {
        [lo, hi] = [Number(range[0]), Number(range[1])];
        if (lo > hi) [lo, hi] = [hi, lo];
    }
    return {
        fileId,
        data,
        timeVar,
        byRow,
        names,
        candidates,
        kernels,
        range: range ? [lo, hi] : null,
        windows: groupWindows ? groupWindows.map(w => [w.startMs, w.endMs]) : null,
        sourceRange: undefined,
    };
};

// Move a kernel to its next pass, unless it must wait: a period's window, past
// its scan, for the whole range's step; any kernel past its days pass, for the
// days every file's signals hold holes on.
proto._advanceLazyIntegralKernel = function(kernel, initial = false) {
    if (kernel.done) return;
    if (!initial) {
        const stage = kernel.pass?.stage;
        if (stage === 'scan' && kernel.parent && !(kernel.parent.verdict || kernel.parent.ready)) {
            kernel.parked = true;
            return;
        }
        if (stage === 'days' && !kernel.released) {
            kernel.daysPass = kernel.pass;
            kernel.waiting = true;
            kernel.released = true;
            return;
        }
    }
    kernel.parked = false;
    const step = kernel.gen.next();
    if (step.done) {
        kernel.done = true;
        kernel.pass = null;
        kernel.result = step.value;
    } else {
        kernel.pass = step.value;
    }
};

// The stage the file streams next (null: none before the barrier, or with
// `area`, none at all), with the kernels that wait on another set going.
proto._nextLazyIntegralStage = function(file, { area = false } = {}) {
    for (const kernel of file.kernels) {
        if (kernel.parked && (kernel.parent.verdict || kernel.parent.ready)) this._advanceLazyIntegralKernel(kernel, true);
    }
    let best = null;
    for (const kernel of file.kernels) {
        if (kernel.done || kernel.parked || kernel.waiting) continue;
        const stage = kernel.pass.stage;
        if (!area && stage === 'area') continue;
        if (best === null || STAGE_ORDER.get(stage) < STAGE_ORDER.get(best)) best = stage;
    }
    return best;
};

// One stream of the file for `stage`: each kernel whose pass is of that stage
// is fed its slice, chunk by chunk. Resolves to the rows read.
proto._streamLazyIntegralStage = async function(file, stage, { signal = null, chunkRows, onRows = null } = {}) {
    const fed = file.kernels.filter(kernel => !kernel.done && !kernel.parked && !kernel.waiting && kernel.pass.stage === stage);
    const totals = fed.filter(kernel => kernel.window === null);
    const byWindow = new Map();
    for (const kernel of fed) {
        if (kernel.window === null) continue;
        if (!byWindow.has(kernel.windowIndex)) byWindow.set(kernel.windowIndex, []);
        byWindow.get(kernel.windowIndex).push(kernel);
    }
    for (;;) {
        const options = { signal, chunkRows };
        let expectFirst = null;
        if (file.range && !file.byRow) {
            // The rows from the one before the range to the one after it.
            if (file.sourceRange === undefined) file.sourceRange = await this._lazyIntegralSourceRange(file, signal);
            if (file.sourceRange) {
                [options.t0, options.t1] = file.sourceRange.range;
                if (!file.sourceRange.checked) expectFirst = file.sourceRange.first;
            }
        }
        const rows = await this._streamLazyIntegralRows(file, fed, totals, byWindow, options, expectFirst, onRows);
        if (rows !== null) {
            for (const kernel of fed) this._advanceLazyIntegralKernel(kernel);
            return rows;
        }
        // The bounds taken from the rows in memory were not rows of the file
        // as it streams (nothing was fed yet): ask the file for its neighbours.
        file.sourceRange = await this._lazyIntegralSourceRange(file, signal, { exact: true });
    }
};

// The stream of one stage. Resolves to the rows read, or to null — before
// anything is fed — when the stream's first row is not `expectFirst`.
proto._streamLazyIntegralRows = async function(file, fed, totals, byWindow, options, expectFirst, onRows) {
    const signal = options.signal;
    const totalRouter = file.range ? createSliceRouter([file.range]) : null;
    const windowRouter = file.windows && byWindow.size ? createSliceRouter(file.windows) : null;
    let carryT = NaN;
    const carry = new Map(file.names.map(name => [name, NaN]));
    const one = (value) => Float64Array.of(value);
    const feedCarry = (kernels) => {
        for (const kernel of kernels) kernel.pass.chunk(one(carryT), one(carry.get(kernel.varName)));
    };
    const feedRun = (kernels, time, valuesByVar, a, b) => {
        if (b <= a) return;
        const t = time.subarray(a, b);
        for (const kernel of kernels) kernel.pass.chunk(t, valuesByVar.get(kernel.varName).subarray(a, b));
    };
    const end = (kernels) => { for (const kernel of kernels) kernel.pass.end(); };

    let rows = 0;
    let first = true;
    for await (const chunk of streamColumns(file.data, file.names, options)) {
        if (signal?.aborted) throw abortError();
        const n = chunk.x.length;
        if (first) {
            first = false;
            if (expectFirst !== null) {
                if (!Object.is(Number(chunk.x[0]), expectFirst)) return null;
                file.sourceRange.checked = true;
            }
        }
        let rowIndex = null;
        if (file.byRow) {
            rowIndex = new Float64Array(n);
            for (let i = 0; i < n; i++) rowIndex[i] = chunk.rowStart + i;
        }
        const transformed = this._transformFetchedPhaseTrajectory(file.fileId, chunk.x, rowIndex, chunk.yByVar, file.names);
        const time = transformed.time;
        const valuesByVar = transformed.valuesByVar;
        if (totals.length) {
            if (!totalRouter) feedRun(totals, time, valuesByVar, 0, time.length);
            else if (!totalRouter.finished) {
                totalRouter.route(time,
                    (k, a, b) => feedRun(totals, time, valuesByVar, a, b),
                    () => feedCarry(totals),
                    () => end(totals));
            }
        }
        if (windowRouter && !windowRouter.finished) {
            windowRouter.route(time,
                (k, a, b) => { const kernels = byWindow.get(k); if (kernels) feedRun(kernels, time, valuesByVar, a, b); },
                (k) => { const kernels = byWindow.get(k); if (kernels) feedCarry(kernels); },
                (k) => { const kernels = byWindow.get(k); if (kernels) end(kernels); });
        }
        if (time.length) {
            carryT = time[time.length - 1];
            for (const name of file.names) carry.set(name, valuesByVar.get(name)[time.length - 1]);
        }
        rows += n;
        onRows?.(rows);
        // Everything read that any slice of this stage wants: stop the scan.
        const totalsDone = !totals.length || (totalRouter && totalRouter.finished);
        const windowsDone = !windowRouter || windowRouter.finished;
        if (totalsDone && windowsDone && (totalRouter || windowRouter)) break;
    }
    if (signal?.aborted) throw abortError();
    if (first && expectFirst !== null) return null;
    totalRouter?.close(() => {});
    windowRouter?.close(() => {});
    end(fed);
    return rows;
};

// The source range a ranged stream reads: from the last row before the range
// to the first row after it, so the transformed time can cut the neighbours
// itself. Widened a hair, as the lazy histogram's, for the conversion of the
// bounds to the source axis. Resolves to { range, first, checked }.
//
// The neighbours lie between the nearest rows of the file the panel already
// knows: the overview in memory is rows of the file, and the metadata holds
// its first and last time. Streaming from the overview's last row before the
// range to its first row after it reads a few more rows than needed (the
// router cuts them) and spares a scan of the whole file to find the exact
// neighbours. That holds only if those times are the stream's: the stream
// must begin on the row the lower bound came from (`first`), which the first
// chunk checks before anything is fed. Otherwise — or when the overview has
// no row before the range — the file is asked (`exact`, one aggregate scan).
proto._lazyIntegralSourceRange = async function(file, signal, { exact = false } = {}) {
    const source = this._sourceRangeForDisplayRange(file.fileId, file.range, file.timeVar);
    if (!source || !source.every(Number.isFinite)) return null;
    let [a, b] = source;
    if (a > b) [a, b] = [b, a];
    const pad = (b - a) * 1e-9 + Math.max(Math.abs(a), Math.abs(b), 1) * 1e-12;
    a -= pad;
    b += pad;
    if (!exact) {
        const known = this._lazyIntegralKnownTimes(file);
        let below = -Infinity;
        let above = Infinity;
        for (let i = 0; i < known.length; i++) {
            const t = known[i];
            if (t < a && t > below) below = t;
            else if (t > b && t < above) above = t;
        }
        const end = Number(file.data?.metadata?.timeEnd);
        if (Number.isFinite(below)) {
            const upper = Number.isFinite(above) ? above : (Number.isFinite(end) && end <= b ? b : null);
            if (upper !== null) return { range: [below, upper], first: below, checked: false };
        }
    }
    const duck = file.data?._duckdb?.source;
    const near = duck?.neighborTimes ? await duck.neighborTimes(file.data, a, b, { signal }) : { before: null, after: null };
    return { range: [near.before ?? a, near.after ?? b], first: null, checked: true };
};

// Source times of rows of the file the panel holds: the overview's, and the
// file's first and last.
proto._lazyIntegralKnownTimes = function(file) {
    const data = file.data;
    const timeName = data?.metadata?.timeName;
    const overview = timeName ? data?.variables?.[timeName]?.data : null;
    const out = [];
    for (const value of overview || []) {
        const t = Number(value);
        if (Number.isFinite(t)) out.push(t);
    }
    for (const value of [data?.metadata?.timeStart, data?.metadata?.timeEnd]) {
        const t = Number(value);
        if (Number.isFinite(t)) out.push(t);
    }
    return out;
};
}
