import { asFloat64, normalizeMovingAverageWindow } from './shared.js';

// Centred moving average over a sliding window, skipping non-finite samples.
//
// The original was already an O(n) running sum — the only changes here are
// typed input/output and inlining the add/remove closures. The running sum is
// order-sensitive in floating point, so the add/remove sequence is preserved
// exactly as it was rather than recomputed per window.
//
// The array function is a conductor over the incremental form below: one push
// of the whole series. A file too large to hold is pushed a chunk at a time by
// the chunked executor (src/data/chunk-executor.js) and gets the same doubles,
// because it runs the same additions and subtractions in the same order.
export function computeMovingAverage(sourceValues, params = {}) {
    return createMovingAverage(params).push(asFloat64(sourceValues), true);
}

/**
 * The moving average as an object fed a series in order, a chunk at a time.
 *
 *   const average = createMovingAverage({ window: 21 });
 *   for (const chunk of chunks) emit(average.push(chunk));
 *   emit(average.flush());
 *
 * `push` returns the outputs it can already give, in order: output i needs the
 * samples up to i + right, so they trail the input by `right` samples, and
 * `flush` gives the rest. Concatenated, the outputs are what the array
 * function returns for the whole series, bit for bit, however it was cut.
 * `push(chunk, true)` is a push and a flush in one, into one array.
 *
 * The window depends on the length of the series (a window wider than the
 * series shrinks to it), which is not known until the end. It only matters
 * when the series is shorter than the window, so nothing is given until a
 * window's worth of samples has arrived: then the window is the requested
 * one whatever the length turns out to be.
 *
 * Options, for kernels built on this one:
 *   · windowForLength(n) — the window the array function uses for a series of
 *     n samples. It must give the same value for every n at or above
 *     windowForLength(Infinity).
 *   · residual — give value − average instead of the average, NaN unless both
 *     are finite (the moving-average detrend). `used` counts those samples.
 *
 * Memory held: the samples of one window, plus the chunk being read.
 */
export function createMovingAverage(params = {}, options = {}) {
    const windowForLength = options.windowForLength
        || (n => normalizeMovingAverageWindow(params.window, n));
    const residual = !!options.residual;
    const fullWindow = windowForLength(Infinity);

    // Samples [base, received) are held: from the oldest one still to be
    // subtracted. Indexes below are absolute positions in the series.
    let held = new Float64Array(0);
    let base = 0;
    let received = 0;
    let window = 0;
    let left = 0;
    let right = 0;
    // The loop state of the array function, carried from one push to the next.
    let next = 0;
    let start = 0;
    let end = -1;
    let sum = 0;
    let count = 0;
    let used = 0;
    let done = false;

    const setWindow = (value) => {
        window = value;
        left = Math.floor((window - 1) / 2);
        right = window - left - 1;
    };

    function push(chunk, final = false) {
        if (done) throw new Error('moving average: push after flush');
        const values = chunk ? asFloat64(chunk) : null;
        let work = held;
        if (values?.length) {
            if (!held.length) {
                work = values;
            } else {
                work = new Float64Array(held.length + values.length);
                work.set(held, 0);
                work.set(values, held.length);
            }
            received += values.length;
        }
        if (!window) {
            if (received >= fullWindow) setWindow(fullWindow);
            else if (final) setWindow(windowForLength(received));
        }
        if (!window) {
            // Not a window's worth yet: keep everything.
            held = work === values ? Float64Array.from(values) : work;
            return new Float64Array(0);
        }

        const n = received;
        const last = final ? n : n - right;
        const out = new Float64Array(Math.max(0, last - next));
        let k = 0;
        for (let i = next; i < last; i++) {
            const nextStart = i - left > 0 ? i - left : 0;
            const nextEnd = i + right < n - 1 ? i + right : n - 1;
            while (end < nextEnd) {
                const value = work[++end - base];
                if (Number.isFinite(value)) { sum += value; count++; }
            }
            while (start < nextStart) {
                const value = work[start++ - base];
                if (Number.isFinite(value)) { sum -= value; count--; }
            }
            const mean = count ? sum / count : NaN;
            if (residual) {
                const value = work[i - base];
                if (Number.isFinite(value) && Number.isFinite(mean)) {
                    out[k++] = value - mean;
                    used++;
                } else {
                    out[k++] = NaN;
                }
            } else {
                out[k++] = mean;
            }
        }
        next = last > next ? last : next;

        if (final) {
            done = true;
            held = new Float64Array(0);
        } else {
            // Keep from the oldest sample a later output still subtracts. A
            // copy: the chunk belongs to the caller, and may be a view of
            // something larger than what is kept.
            held = work.slice(start - base);
            base = start;
        }
        return out;
    }

    return {
        push,
        flush: () => push(null, true),
        // Samples whose output is finite in residual mode — the detrend's fit
        // points. Final once flushed.
        get used() { return used; },
        // How far the outputs trail the inputs once the window is known.
        get lag() { return window ? right : null; },
    };
}
