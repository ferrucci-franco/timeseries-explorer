// Kernels without state, fed a series a chunk at a time.
//
// The moving average and the filter carry state from one chunk to the next
// (moving-average.js, iir.js). The spike detector, the fill of missing samples
// and the interpolation of outliers do not: the output of row i depends only
// on the rows around it — a fixed window for the spike detector, "up to the
// next finite sample" for the others. The two adapters here turn a function
// over an array with a core — compute(view) → the outputs for the rows of the
// core, given the rows around them — into the push/flush form the chunked
// executor speaks (src/data/chunk-executor.js), so that the same function run
// on the whole series in one call gives, bit for bit, what it gives run on a
// file a chunk at a time. The array functions (fillMissingValues,
// computeIntegral) are one such call.
//
// A view:
//   { values, times, aux, start, coreStart, coreEnd, fileStart, eof,
//     truncatedStart, truncatedEnd }
// `values` are the rows the compute may read — the core, [coreStart, coreEnd)
// in `values`' own indexes, with the rows kept before it and read ahead of it.
// `start` is the file position of values[0]; `times` and `aux` (bytes) travel
// alongside when the kernel reads them. `fileStart` says values[0] is the
// first row of the series, `eof` that the last is its last. `truncatedStart`
// and `truncatedEnd` say a cap cut the rows kept or read ahead: what lies
// beyond is unknown, which is not the same as nothing being there.

// How many rows a kernel may wait for — a hole of missing samples longer than
// this is not bridged (fillMissingValues skips it, the integral adds nothing
// across it, an outlier beside it becomes NaN) — and how many it may keep
// behind. 4 M rows: 32 MB per column held in memory, at most, plus the chunk.
export const LOOKAHEAD_MAX_ROWS = 1 << 22;

import { cloneKernelState } from './shared.js';

function concatFloat64(parts) {
    if (parts.length === 1) return parts[0];
    const out = new Float64Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
}

function concatBytes(parts) {
    if (parts.every(part => !part)) return null;
    const out = new Uint8Array(parts.reduce((n, part) => n + (part?.length || 0), 0));
    let at = 0;
    for (const part of parts) { if (part) { out.set(part, at); at += part.length; } }
    return out;
}

/**
 * A kernel whose output for a row depends on a fixed number of rows around it.
 *
 *   const kernel = createOverlapKernel(compute, { before: 60, after: 60 });
 *   for (const chunk of chunks) emit(await kernel.push(chunk));
 *   emit(await kernel.flush());
 *
 * Each push whose rows reach `after` past the last output row becomes a core;
 * compute gets it with `before` rows kept before it and `after` rows read
 * after it (fewer at the ends of the series, where there are none). compute
 * may return a promise — the point: a run in a worker — and up to `depth`
 * cores are in flight at once; what push returns are the outputs that are in,
 * in order. compute returns the core's outputs as one Float64Array, or
 * `{ values, aux }` with a byte per row alongside (flags). push and flush
 * return `{ values, aux }`, `aux` null when no compute gave one.
 *
 * Memory held: `before` rows, the chunk, and the cores in flight.
 */
export function createOverlapKernel(compute, { before = 0, after = 0, depth = 1, withTime = false } = {}) {
    let buffer = new Float64Array(0);
    let times = withTime ? new Float64Array(0) : null;
    let bufferStart = 0;   // file position of buffer[0]
    let received = 0;      // rows pushed so far
    let next = 0;          // first row with no output yet
    const pending = [];    // cores in flight, in order
    let done = false;

    const append = (values, x) => {
        if (!values?.length) return;
        const grown = new Float64Array(buffer.length + values.length);
        grown.set(buffer, 0);
        grown.set(values, buffer.length);
        buffer = grown;
        if (times) {
            const grownTimes = new Float64Array(times.length + values.length);
            grownTimes.set(times, 0);
            if (x) grownTimes.set(x, times.length);
            else grownTimes.fill(NaN, times.length);
            times = grownTimes;
        }
        received += values.length;
    };

    const schedule = (coreStart, coreEnd, eof) => {
        const from = Math.max(bufferStart, coreStart - before);
        const to = Math.min(received, coreEnd + after);
        const view = {
            values: buffer.slice(from - bufferStart, to - bufferStart),
            times: times ? times.slice(from - bufferStart, to - bufferStart) : null,
            aux: null,
            start: from,
            coreStart: coreStart - from,
            coreEnd: coreEnd - from,
            fileStart: from === 0,
            eof,
            truncatedStart: false,
            truncatedEnd: false,
        };
        pending.push(Promise.resolve(compute(view)).then(out => shape(out, coreEnd - coreStart)));
        next = coreEnd;
        // Keep `before` rows behind the next core.
        const keep = Math.max(bufferStart, next - before);
        if (keep > bufferStart) {
            buffer = buffer.slice(keep - bufferStart);
            if (times) times = times.slice(keep - bufferStart);
            bufferStart = keep;
        }
    };

    const shape = (out, rows) => {
        const shaped = !!out && !ArrayBuffer.isView(out);
        const values = shaped ? out.values : out;
        const aux = shaped ? (out.aux || null) : null;
        if (!values || values.length !== rows) {
            throw new Error(`overlap kernel: ${values?.length ?? 'no'} outputs for a core of ${rows} rows`);
        }
        return { values, aux };
    };

    const drain = async (all) => {
        const outs = [];
        while (pending.length && (all || pending.length > depth)) outs.push(await pending.shift());
        return {
            values: outs.length ? concatFloat64(outs.map(o => o.values)) : new Float64Array(0),
            aux: concatBytes(outs.map(o => o.aux)),
        };
    };

    return {
        async push(values, x = null) {
            if (done) throw new Error('overlap kernel: push after flush');
            append(values, x);
            if (received - after > next) schedule(next, received - after, false);
            return drain(false);
        },
        async flush() {
            if (done) throw new Error('overlap kernel: flush twice');
            done = true;
            if (received > next) schedule(next, received, true);
            return drain(true);
        },
        // The outputs of the cores in flight, all of them: what save needs
        // first, since a core in flight is not state that can be copied.
        settle: () => drain(true),
        // The rows kept and the cursor (see createMovingAverage on save/load);
        // only with no core in flight.
        save() {
            if (pending.length) throw new Error('overlap kernel: save with cores in flight (settle first)');
            return cloneKernelState({ buffer, times, bufferStart, received, next, done });
        },
        load(saved) {
            ({ buffer, times, bufferStart, received, next, done } = cloneKernelState(saved));
            pending.length = 0;
        },
    };
}

/**
 * A kernel whose output for a row may depend on rows an unknown distance
 * ahead — up to the next finite sample — and that decides itself how far it
 * can go.
 *
 *   const kernel = createLookaheadKernel(compute, { cap });
 *   for (const chunk of chunks) emit(kernel.push(chunk));
 *   emit(kernel.flush());
 *
 * compute gets every row kept and read so far, the core being all the rows
 * without an output yet, and returns `{ values, settled, keepFrom }`:
 * `settled` rows of the core, from its start, now have their outputs
 * (`values`, that long); `keepFrom` is the index in the view from which the
 * rows are still needed for the rows after — a neighbour a later hole is
 * bridged from, a window of samples. compute may settle nothing and wait for
 * more rows. It is called again at each push with more rows, and at flush
 * with `eof`, when it must settle everything.
 *
 * Two caps bound the wait and the memory: when `cap` rows are kept behind the
 * core, or read ahead of its first row without compute settling it, the view
 * is cut there and says so (`truncatedStart`, `truncatedEnd`); with
 * `truncatedEnd` compute must settle every row of the core, treating the end
 * of the view as unknown rather than as the end of the series.
 *
 * compute runs on the calling thread, in order; it may keep state between
 * calls (the integral's accumulator). push and flush are synchronous and
 * return `{ values, aux }` — `aux` is passed through from the rows pushed,
 * never produced.
 *
 * Memory held: at most `cap` rows behind the core and `cap` rows of it.
 */
export function createLookaheadKernel(compute, { cap = LOOKAHEAD_MAX_ROWS, withTime = false, withAux = false } = {}) {
    let buffer = new Float64Array(0);
    let times = withTime ? new Float64Array(0) : null;
    let aux = withAux ? new Uint8Array(0) : null;
    let bufferStart = 0;
    let received = 0;
    let next = 0;
    let truncatedStart = false;
    let done = false;

    const append = (values, x, flags) => {
        if (!values?.length) return;
        const grown = new Float64Array(buffer.length + values.length);
        grown.set(buffer, 0);
        grown.set(values, buffer.length);
        buffer = grown;
        if (times) {
            const grownTimes = new Float64Array(times.length + values.length);
            grownTimes.set(times, 0);
            if (x) grownTimes.set(x, times.length);
            else grownTimes.fill(NaN, times.length);
            times = grownTimes;
        }
        if (aux) {
            const grownAux = new Uint8Array(aux.length + values.length);
            grownAux.set(aux, 0);
            if (flags) grownAux.set(flags, aux.length);
            aux = grownAux;
        }
        received += values.length;
    };

    const settle = (final) => {
        const outs = [];
        while (next < received) {
            const truncatedEnd = !final && received - next >= cap;
            const view = {
                values: buffer,
                times,
                aux,
                start: bufferStart,
                coreStart: next - bufferStart,
                coreEnd: received - bufferStart,
                fileStart: bufferStart === 0,
                eof: final,
                truncatedStart,
                truncatedEnd,
            };
            const result = compute(view);
            const settled = Math.max(0, Math.round(Number(result?.settled) || 0));
            if (!settled) {
                if (final || truncatedEnd) {
                    if (next < received) throw new Error(`lookahead kernel: ${received - next} rows left unsettled at the ${final ? 'end' : 'cap'}`);
                }
                break;
            }
            if (settled > received - next) throw new Error(`lookahead kernel: ${settled} rows settled of ${received - next}`);
            if (!result.values || result.values.length !== settled) {
                throw new Error(`lookahead kernel: ${result.values?.length ?? 'no'} outputs for ${settled} rows settled`);
            }
            outs.push(result.values);
            next += settled;
            // Keep from where the kernel asks, within the cap.
            let keep = bufferStart + Math.max(0, Math.min(view.coreStart + settled, Math.round(Number(result.keepFrom) || 0)));
            truncatedStart = false;
            if (next - keep > cap) { keep = next - cap; truncatedStart = true; }
            if (keep > bufferStart) {
                buffer = buffer.slice(keep - bufferStart);
                if (times) times = times.slice(keep - bufferStart);
                if (aux) aux = aux.slice(keep - bufferStart);
                bufferStart = keep;
            }
            if (next >= received) break;
        }
        return { values: outs.length ? concatFloat64(outs) : new Float64Array(0), aux: null };
    };

    return {
        push(values, x = null, flags = null) {
            if (done) throw new Error('lookahead kernel: push after flush');
            append(values, x, flags);
            return settle(false);
        },
        flush() {
            if (done) throw new Error('lookahead kernel: flush twice');
            done = true;
            const out = settle(true);
            buffer = new Float64Array(0);
            times = times && new Float64Array(0);
            aux = aux && new Uint8Array(0);
            return out;
        },
        // The rows kept and the cursor (see createMovingAverage on save/load);
        // the state of compute, if it keeps any, is the caller's to save.
        save: () => cloneKernelState({ buffer, times, aux, bufferStart, received, next, truncatedStart, done }),
        load(saved) {
            ({ buffer, times, aux, bufferStart, received, next, truncatedStart, done } = cloneKernelState(saved));
        },
    };
}
