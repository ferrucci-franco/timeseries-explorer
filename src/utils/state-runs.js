// What a state band draws (docs/state-band-design.md).
//
// A text column (`estado`, `modo`, `alarma`) has no magnitude: what changes
// along time is WHICH value holds, so the band shows it by colour, never by
// height. The column is read once into runs — maximal stretches of
// consecutive rows holding the same value — and every view after that is a
// binary search into the runs, not a scan of the rows.
//
// A value holds from its row until the next row (step semantics, as for a
// boolean). An empty cell is an absent value: the band is blank there, as a
// NaN leaves a hole in a numeric trace. Rows sharing one instant give runs of
// zero length; they are drawn as nothing and counted as changes when a screen
// column is reduced.
//
// Pure: no DOM, no Plotly. Times are the file's numeric time vector (epoch ms
// on a calendar axis, seconds or index otherwise), ascending.

/** Runs drawn one bar each, at most; past this the view is reduced per column. */
export const STATE_BAND_MAX_RUNS = 4000;
/** Width of a screen column of the reduced band, in pixels. */
export const STATE_BAND_COLUMN_PX = 2;
/** Distinct values past which a column is not coloured by value. */
export const STATE_BAND_MAX_VALUES = 16;
/** Code of an absent (empty) value. */
export const STATE_ABSENT = -1;

/** The text a cell holds, as the band compares it: trimmed; null is empty. */
export function normalizeStateValue(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

/**
 * Read a text column into runs.
 *
 * Returns `{ starts, codes, table, length }`:
 * - `starts[i]`: row where run i begins;
 * - `codes[i]`: index of its value in `table`, or STATE_ABSENT;
 * - `table`: the distinct non-empty values, in order of first appearance;
 * - `length`: rows read, so a longer array (a live update) can be continued
 *   by extendStateRuns instead of read again.
 */
export function encodeStateRuns(values) {
    const enc = { starts: [], codes: [], table: [], index: new Map(), length: 0 };
    return extendStateRuns(enc, values);
}

/**
 * Continue `enc` over the rows of `values` past `enc.length`. The last run can
 * carry on. Returns `enc` (mutated). A shorter array than what was read means
 * the column was replaced: read it again from the start.
 */
export function extendStateRuns(enc, values) {
    const n = values?.length || 0;
    if (!enc || n < enc.length) return encodeStateRuns(values);
    let lastCode = enc.codes.length ? enc.codes[enc.codes.length - 1] : null;
    for (let row = enc.length; row < n; row++) {
        const text = normalizeStateValue(values[row]);
        let code = STATE_ABSENT;
        if (text !== '') {
            code = enc.index.get(text);
            if (code === undefined) {
                code = enc.table.length;
                enc.table.push(text);
                enc.index.set(text, code);
            }
        }
        if (code !== lastCode) {
            enc.starts.push(row);
            enc.codes.push(code);
            lastCode = code;
        }
    }
    enc.length = n;
    return enc;
}

/** Number of distinct non-empty values the column holds. */
export function stateDistinctCount(enc) {
    return enc?.table?.length || 0;
}

/** Whether a column has too many values to be coloured by value. */
export function stateBandOverflows(distinctCount) {
    return Number(distinctCount) > STATE_BAND_MAX_VALUES;
}

// Start time of run i.
function runStart(enc, times, i) {
    return Number(times[enc.starts[i]]);
}

/**
 * End time of run i: where the next run starts, or for the last run the last
 * row plus `lastStep` (the file's nominal step), so a value seen only on the
 * last row still shows.
 */
export function stateRunEnd(enc, times, i, lastStep = 0) {
    if (i + 1 < enc.starts.length) return runStart(enc, times, i + 1);
    const lastRow = Math.min(enc.length, times?.length || 0) - 1;
    const last = Number(times[lastRow]);
    const step = Number(lastStep);
    return Number.isFinite(step) && step > 0 ? last + step : last;
}

/**
 * Runs overlapping [lo, hi], as a half-open index range [first, end). The run
 * that started before `lo` and still holds there is included: a state that
 * began off screen is the state on the left edge.
 */
export function sliceStateRuns(enc, times, lo = -Infinity, hi = Infinity) {
    const count = enc?.starts?.length || 0;
    if (!count) return { first: 0, end: 0 };
    // Last run starting at or before lo.
    let a = 0;
    let b = count;
    while (a < b) {
        const mid = (a + b) >>> 1;
        if (runStart(enc, times, mid) <= lo) a = mid + 1;
        else b = mid;
    }
    const first = Math.max(0, a - 1);
    // First run starting after hi.
    a = first;
    b = count;
    while (a < b) {
        const mid = (a + b) >>> 1;
        if (runStart(enc, times, mid) <= hi) a = mid + 1;
        else b = mid;
    }
    return { first, end: a };
}

/**
 * What a band draws for the view [lo, hi]: segments `{ t0, t1, code, changes }`
 * in time order, absent runs left out.
 *
 * Up to `maxRuns` runs in view, one segment per run, exact. Past that the view
 * is cut into screen columns of `columnPx` pixels across `widthPx`; each
 * column takes the value that holds longest in it and counts the changes that
 * happen inside it, and neighbouring columns of the same value merge. So a
 * column changing on every row of a file of millions costs as many bars as
 * there are pixels, and zooming in gives the exact runs back.
 */
export function buildStateSegments(enc, times, options = {}) {
    const {
        lo = -Infinity,
        hi = Infinity,
        widthPx = 1000,
        lastStep = 0,
        maxRuns = STATE_BAND_MAX_RUNS,
        columnPx = STATE_BAND_COLUMN_PX,
    } = options;
    const { first, end } = sliceStateRuns(enc, times, lo, hi);
    if (end <= first) return { segments: [], reduced: false };
    if (end - first <= maxRuns) {
        const segments = [];
        for (let i = first; i < end; i++) {
            const code = enc.codes[i];
            if (code === STATE_ABSENT) continue;
            segments.push({ t0: runStart(enc, times, i), t1: stateRunEnd(enc, times, i, lastStep), code, changes: 0 });
        }
        return { segments, reduced: false };
    }
    return { segments: reduceStateRuns(enc, times, first, end, { lo, hi, widthPx, lastStep, columnPx }), reduced: true };
}

/**
 * The per-column reduction of runs [first, end) over [lo, hi]. Exported for
 * the tests and for the lazy path, which reduces rows it fetched itself.
 */
export function reduceStateRuns(enc, times, first, end, options = {}) {
    const { widthPx = 1000, lastStep = 0, columnPx = STATE_BAND_COLUMN_PX } = options;
    let lo = Number(options.lo);
    let hi = Number(options.hi);
    if (!Number.isFinite(lo)) lo = runStart(enc, times, first);
    if (!Number.isFinite(hi)) hi = stateRunEnd(enc, times, end - 1, lastStep);
    const columns = Math.max(1, Math.ceil(Math.max(1, Number(widthPx) || 1) / Math.max(1, columnPx)));
    const span = hi - lo;
    if (!(span > 0)) {
        const code = enc.codes[first];
        return code === STATE_ABSENT ? [] : [{ t0: lo, t1: hi, code, changes: end - first - 1 }];
    }
    const colWidth = span / columns;
    const segments = [];
    let col = 0;
    let weights = new Map();
    let changes = 0;
    const flush = () => {
        let best = STATE_ABSENT;
        let bestWeight = -1;
        for (const [code, weight] of weights) {
            if (weight > bestWeight) { best = code; bestWeight = weight; }
        }
        const t0 = lo + col * colWidth;
        const t1 = col === columns - 1 ? hi : lo + (col + 1) * colWidth;
        if (bestWeight >= 0 && best !== STATE_ABSENT) {
            const prev = segments[segments.length - 1];
            if (prev && prev.code === best && prev.t1 === t0) {
                prev.t1 = t1;
                prev.changes += changes;
            } else {
                segments.push({ t0, t1, code: best, changes });
            }
        }
        weights = new Map();
        changes = 0;
    };
    for (let i = first; i < end; i++) {
        const code = enc.codes[i];
        let s = Math.max(lo, runStart(enc, times, i));
        const e = Math.min(hi, stateRunEnd(enc, times, i, lastStep));
        if (s > hi) break;
        // A run beginning inside the view is a change there; the run that was
        // already holding at the left edge is not.
        const startCol = Math.min(columns - 1, Math.floor((s - lo) / colWidth));
        while (col < startCol) { flush(); col++; }
        if (i > first && runStart(enc, times, i) >= lo) changes++;
        if (e <= s) {
            // Zero length (rows at one instant): counted, never dominant.
            if (!weights.has(code)) weights.set(code, 0);
            continue;
        }
        while (s < e) {
            const colEnd = col === columns - 1 ? hi : lo + (col + 1) * colWidth;
            if (colEnd <= s) {
                // Rounding put a boundary at or before s: move on a column.
                if (col >= columns - 1) break;
                flush();
                col++;
                continue;
            }
            const stop = Math.min(e, colEnd);
            weights.set(code, (weights.get(code) || 0) + (stop - s));
            s = stop;
            if (s < e) {
                if (col >= columns - 1) break;
                flush();
                col++;
            }
        }
    }
    flush();
    // Columns past the last run (a view wider than the data) stay blank.
    return segments;
}

/**
 * The row holding at time `t`: the last row at or before it, or -1 before the
 * first. A state holds forward, so this is the hover's question, not "nearest".
 */
export function stateRowAtOrBefore(times, t) {
    const n = times?.length || 0;
    let a = 0;
    let b = n;
    while (a < b) {
        const mid = (a + b) >>> 1;
        if (Number(times[mid]) <= t) a = mid + 1;
        else b = mid;
    }
    return a - 1;
}
