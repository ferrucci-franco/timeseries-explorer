import { asFloat64, normalizeTimeContext } from './shared.js';

// The edges of a signal, and what happens between them: how long it takes a
// signal to change (the interval), and how fast it changed on average (the
// rate). A building-management export, for one, writes a row every minute
// whatever an energy meter does; the meter's own updates are where the value
// moves, and the mean power between two of them is exact.
//
// An edge is a move of at least `deadband` away from the value at the last
// edge — the reference — not from the previous sample. That is a dead band
// with memory, as a BACnet "change of value" increment works:
//
//   · a slow drift that never moves `deadband` in one sample still makes an
//     edge once it has moved that far in total;
//   · noise around a level never does, so it cannot make a rising and a
//     falling edge out of every wiggle.
//
// A deadband of 0 makes every change an edge, and then the reference is the
// previous finite sample. Each edge moves the reference to the sample that
// made it, whichever direction is counted: after a fall, a rise is measured
// from where the signal fell to.
//
// Between two consecutive edges of the chosen direction, k−1 and k:
//
//   interval  Δt_k = t_k − t_(k−1)
//   rate      r_k = (y_k − y_(k−1)) / Δt_k   — the secant, not a derivative:
//             the mean rate over the interval, exact for a cumulative counter
//             (between two of its steps it moved by exactly y_k − y_(k−1)),
//             whatever the deadband. With falls in between (rising edges
//             only) it is the net change.
//
// Placed one of two ways, on the same rows as the source:
//
//   · 'edge' — on the row of edge k only, NaN everywhere else. A histogram
//     counts each interval once.
//   · 'hold' — on every row of [t_(k−1), t_k): from the edge that opens the
//     interval up to the row before the edge that closes it. Held as stairs
//     (each sample until the next) it covers exactly the interval, so the
//     rectangular sum Σ r·Δt over its rows gives back y_k − y_(k−1): a rate
//     held this way integrates back to the counter. Before the first edge and
//     after the last one there is no complete interval: NaN.
//
// Times follow timeDelta (shared.js): seconds on a date/time axis, the axis's
// own unit on a numeric one, samples on an index. A rate is per second times
// the `rateUnit` factor (per minute ×60, per hour ×3600) — per sample on an
// index, where there is no second to scale.

export const INTERARRIVAL_EDGES = new Set(['rising', 'falling', 'both']);
export const INTERARRIVAL_OUTPUTS = new Set(['interval', 'rate']);
export const INTERARRIVAL_PLACEMENTS = new Set(['edge', 'hold']);
export const INTERARRIVAL_RATE_UNITS = { s: 1, min: 60, h: 3600 };
// A held interval longer than this many rows is left NaN: its rows wait for
// the edge that closes it, and on a file read a chunk at a time each waiting
// row costs memory. Applied in memory too, so both paths give the same values.
export const INTERARRIVAL_MAX_HOLD_ROWS = 1 << 22;

export function normalizeInterarrivalParams(params = {}) {
    const edge = INTERARRIVAL_EDGES.has(params.edge) ? params.edge : 'both';
    const raw = Number(params.deadband);
    const deadband = Number.isFinite(raw) && raw > 0 ? raw : 0;
    // Definitions saved before the rate existed carry neither: the interval,
    // at the edge, is exactly what they computed.
    const output = INTERARRIVAL_OUTPUTS.has(params.output) ? params.output : 'interval';
    const placement = INTERARRIVAL_PLACEMENTS.has(params.placement) ? params.placement : 'edge';
    const rateUnit = Object.hasOwn(INTERARRIVAL_RATE_UNITS, params.rateUnit ?? '') ? params.rateUnit : 's';
    return { edge, deadband, output, placement, rateUnit };
}

/**
 * The whole series at once: one push of the incremental form below, and its
 * flush.
 * @returns {{ values: Float64Array } & ReturnType<ReturnType<typeof createInterarrival>['report']>}
 */
export function computeInterarrival(sourceValues, time, params = {}, options = {}) {
    const values = asFloat64(sourceValues);
    const ctx = normalizeTimeContext(time);
    const timed = ctx.kind !== 'index' && !!ctx.values && ctx.values.length === values.length;
    const kernel = createInterarrival(params, { ...options, kind: timed ? ctx.kind : 'index' });
    const head = kernel.push(values, timed ? ctx.values : null);
    const tail = kernel.flush();
    let out = head;
    if (tail.length) {
        out = new Float64Array(head.length + tail.length);
        out.set(head, 0);
        out.set(tail, head.length);
    }
    return { values: out, ...kernel.report() };
}

/**
 * The kernel as an object fed the series in order, a chunk at a time (the
 * chunked executor, src/data/chunk-executor.js). `push` gives the outputs it
 * can already give, in order, and `flush` the rest. At the edge, that is one
 * output per input; held, the rows of an interval wait for the edge that
 * closes it (the executor keeps their positions meanwhile). Concatenated, the
 * outputs are what computeInterarrival returns, however the series was cut.
 *
 * `kind` is the time axis's ('numeric' | 'datetime' | 'index'). With 'index',
 * or when a chunk comes without times, the time of a sample is its position in
 * the series, counted across chunks.
 *
 * A sample whose value or time is not finite makes no edge and leaves the
 * reference where it was; held, it still lies inside an interval and carries
 * its value.
 *
 * Memory held: a handful of numbers, and while holding, nothing per waiting
 * row (they are only counted).
 */
export function createInterarrival(params = {}, { kind = 'numeric', maxHoldRows = INTERARRIVAL_MAX_HOLD_ROWS } = {}) {
    const { edge, deadband, output, placement, rateUnit } = normalizeInterarrivalParams(params);
    const datetime = kind === 'datetime';
    const byIndex = kind === 'index';
    const wantRising = edge !== 'falling';
    const wantFalling = edge !== 'rising';
    const rate = output === 'rate';
    const hold = placement === 'hold';
    const scale = byIndex ? 1 : INTERARRIVAL_RATE_UNITS[rateUnit];
    const holdCap = Math.max(1, Math.floor(Number(maxHoldRows) || INTERARRIVAL_MAX_HOLD_ROWS));

    let position = 0;
    let hasRef = false;
    let ref = NaN;
    let hasLast = false;
    let lastTime = NaN;
    let lastValue = NaN;
    let risingCount = 0;
    let fallingCount = 0;
    let intervalCount = 0;
    let negativeDtCount = 0;
    let zeroDtCount = 0;
    let sumDt = 0;
    let minDt = Infinity;
    let maxDt = -Infinity;
    let sumDy = 0;
    let sumRateDt = 0;
    let minRate = Infinity;
    let maxRate = -Infinity;
    let minJump = Infinity;
    let maxJump = -Infinity;
    // Held: rows of the open interval not given yet, and whether that interval
    // outgrew the cap (then its rows go out as NaN as they come).
    let pending = 0;
    let dropping = false;
    let droppedIntervals = 0;
    let done = false;

    // The value of the interval just closed, or NaN when it has none (the
    // first edge; a rate over no time or time going backwards).
    function close(t, y) {
        if (!hasLast) return NaN;
        const dt = datetime ? (t - lastTime) / 1000 : t - lastTime;
        if (dt < 0) negativeDtCount++;
        if (dt === 0) zeroDtCount++;
        if (rate && !(dt > 0)) return NaN;
        intervalCount++;
        sumDt += dt;
        if (dt < minDt) minDt = dt;
        if (dt > maxDt) maxDt = dt;
        if (!rate) return dt;
        const dy = y - lastValue;
        const r = (dy / dt) * scale;
        sumDy += dy;
        sumRateDt += dt;
        if (r < minRate) minRate = r;
        if (r > maxRate) maxRate = r;
        return r;
    }

    function push(chunk, times = null) {
        if (done) throw new Error('interarrival: push after flush');
        const values = chunk ? asFloat64(chunk) : new Float64Array(0);
        const n = values.length;
        const readTime = !byIndex && times && times.length >= n;
        // At the edge: one output per input. Held: up to the waiting rows
        // plus this chunk's.
        const out = new Float64Array(hold ? pending + n : n).fill(NaN);
        let written = 0;
        const emit = (count, value) => {
            if (count <= 0) return;
            if (value === value) out.fill(value, written, written + count);
            written += count;
        };
        for (let i = 0; i < n; i++, position++) {
            const y = values[i];
            const t = readTime ? times[i] : position;
            let isEdge = false;
            if (Number.isFinite(y) && Number.isFinite(t)) {
                if (!hasRef) {
                    ref = y;
                    hasRef = true;
                } else {
                    const d = y - ref;
                    if (d !== 0 && Math.abs(d) >= deadband) {
                        ref = y;
                        const rising = d > 0;
                        if (rising) risingCount++;
                        else fallingCount++;
                        isEdge = rising ? wantRising : wantFalling;
                        if (isEdge) {
                            const jump = Math.abs(d);
                            if (jump < minJump) minJump = jump;
                            if (jump > maxJump) maxJump = jump;
                        }
                    }
                }
            }
            if (!isEdge) {
                if (!hold) { written++; continue; }
                if (dropping) { written++; continue; }
                pending++;
                if (pending > holdCap) {
                    // Too long to hold: the whole interval goes out as NaN.
                    emit(pending, NaN);
                    pending = 0;
                    dropping = true;
                    droppedIntervals++;
                }
                continue;
            }
            const value = close(t, y);
            if (hold) {
                emit(pending, dropping ? NaN : value);
                pending = 1;
                dropping = false;
            } else {
                out[written++] = value;
            }
            lastTime = t;
            lastValue = y;
            hasLast = true;
        }
        return written === out.length ? out : out.subarray(0, written);
    }

    return {
        push,
        // Held, the rows after the last edge belong to an interval that never
        // closes: NaN.
        flush: () => {
            done = true;
            const out = new Float64Array(hold ? pending : 0).fill(NaN);
            pending = 0;
            return out;
        },
        /**
         * What the run found: edges each way, how many of the chosen ones
         * there were (`edgeCount`) and the size of their jumps, the intervals
         * between them and their mean, minimum and maximum; for a rate, the
         * mean weighted by time (total change over total time — the mean rate
         * of the whole span, not the mean of the rates), minimum and maximum.
         * Null where there is nothing to measure.
         */
        report: () => ({
            edge,
            deadband,
            output,
            placement,
            rateUnit,
            risingCount,
            fallingCount,
            edgeCount: (wantRising ? risingCount : 0) + (wantFalling ? fallingCount : 0),
            intervalCount,
            negativeDtCount,
            zeroDtCount,
            meanDt: intervalCount ? sumDt / intervalCount : null,
            minDt: intervalCount ? minDt : null,
            maxDt: intervalCount ? maxDt : null,
            meanRate: rate && sumRateDt > 0 ? (sumDy / sumRateDt) * scale : null,
            minRate: rate && intervalCount ? minRate : null,
            maxRate: rate && intervalCount ? maxRate : null,
            minJump: Number.isFinite(minJump) ? minJump : null,
            maxJump: Number.isFinite(maxJump) ? maxJump : null,
            droppedIntervals,
            timeKind: kind,
        }),
    };
}
