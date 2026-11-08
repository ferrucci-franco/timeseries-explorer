import { asFloat64, normalizeTimeContext } from './shared.js';

// Interarrival time between the edges of a signal: how long it takes a signal
// to change, rather than how often a row is written. A building-management
// export, for one, writes a row every minute whatever the meter does; the
// meter's own updates are where the value moves.
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
// The output is as long as the input and NaN everywhere but at the edges of
// the chosen direction, which carry the time since the previous edge of that
// direction. The first such edge has no previous one, so it is NaN too.
// Event-aligned on purpose: a histogram of the output counts each interval
// once — holding the value until the next edge would weight every interval
// by its own length.
//
// Times follow timeDelta (shared.js): seconds on a date/time axis, the axis's
// own unit on a numeric one, samples on an index.

export const INTERARRIVAL_EDGES = new Set(['rising', 'falling', 'both']);

export function normalizeInterarrivalParams(params = {}) {
    const edge = INTERARRIVAL_EDGES.has(params.edge) ? params.edge : 'both';
    const raw = Number(params.deadband);
    const deadband = Number.isFinite(raw) && raw > 0 ? raw : 0;
    return { edge, deadband };
}

/**
 * The whole series at once: one push of the incremental form below.
 * @returns {{ values: Float64Array } & ReturnType<ReturnType<typeof createInterarrival>['report']>}
 */
export function computeInterarrival(sourceValues, time, params = {}) {
    const values = asFloat64(sourceValues);
    const ctx = normalizeTimeContext(time);
    const timed = ctx.kind !== 'index' && !!ctx.values && ctx.values.length === values.length;
    const kernel = createInterarrival(params, { kind: timed ? ctx.kind : 'index' });
    const out = kernel.push(values, timed ? ctx.values : null);
    return { values: out, ...kernel.report() };
}

/**
 * The kernel as an object fed the series in order, a chunk at a time (the
 * chunked executor, src/data/chunk-executor.js). Nothing trails: `push` gives
 * one output per input, and `flush` gives none. Concatenated, the outputs are
 * what computeInterarrival returns for the whole series, however it was cut.
 *
 * `kind` is the time axis's ('numeric' | 'datetime' | 'index'). With 'index',
 * or when a chunk comes without times, the time of a sample is its position in
 * the series, counted across chunks.
 *
 * A sample whose value or time is not finite is skipped: no edge, no output,
 * and the reference stays where it was.
 *
 * Memory held: a handful of numbers.
 */
export function createInterarrival(params = {}, { kind = 'numeric' } = {}) {
    const { edge, deadband } = normalizeInterarrivalParams(params);
    const datetime = kind === 'datetime';
    const byIndex = kind === 'index';
    const wantRising = edge !== 'falling';
    const wantFalling = edge !== 'rising';

    let position = 0;
    let hasRef = false;
    let ref = NaN;
    let hasLast = false;
    let lastTime = NaN;
    let risingCount = 0;
    let fallingCount = 0;
    let intervalCount = 0;
    let negativeDtCount = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;

    function push(chunk, times = null) {
        const values = chunk ? asFloat64(chunk) : new Float64Array(0);
        const n = values.length;
        const out = new Float64Array(n).fill(NaN);
        const readTime = !byIndex && times && times.length >= n;
        for (let i = 0; i < n; i++, position++) {
            const y = values[i];
            const t = readTime ? times[i] : position;
            if (!Number.isFinite(y) || !Number.isFinite(t)) continue;
            if (!hasRef) {
                ref = y;
                hasRef = true;
                continue;
            }
            const d = y - ref;
            if (d === 0 || Math.abs(d) < deadband) continue;
            ref = y;
            const rising = d > 0;
            if (rising) risingCount++;
            else fallingCount++;
            if (rising ? !wantRising : !wantFalling) continue;
            if (hasLast) {
                const dt = datetime ? (t - lastTime) / 1000 : t - lastTime;
                out[i] = dt;
                intervalCount++;
                if (dt < 0) negativeDtCount++;
                sum += dt;
                if (dt < min) min = dt;
                if (dt > max) max = dt;
            }
            lastTime = t;
            hasLast = true;
        }
        return out;
    }

    return {
        push,
        flush: () => new Float64Array(0),
        /**
         * What the run found: edges each way, how many of the chosen ones
         * there were (`edgeCount`), the intervals between them, and their
         * mean, minimum and maximum (null without an interval).
         */
        report: () => ({
            edge,
            deadband,
            risingCount,
            fallingCount,
            edgeCount: (wantRising ? risingCount : 0) + (wantFalling ? fallingCount : 0),
            intervalCount,
            negativeDtCount,
            meanDt: intervalCount ? sum / intervalCount : null,
            minDt: intervalCount ? min : null,
            maxDt: intervalCount ? max : null,
            timeKind: kind,
        }),
    };
}
