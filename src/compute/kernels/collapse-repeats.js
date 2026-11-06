// Collapsing rows that share a timestamp.
//
// A logger writing a burst at one instant, a device whose clock is coarser than
// its sampling loop, a Modelica event: several rows land on the same stamp. The
// app no longer takes the time axis away over it (#154) — but the rows are
// still several answers to one question, and a reader usually wants one.
//
// Which one is theirs to say: the mean of the burst, its extremes, or simply
// the row that arrived first or last. Nothing here guesses.
//
// Runs are CONSECUTIVE rows with the same stamp. The app sorts a file by time
// as it reads it, so equal stamps are adjacent; grouping by adjacency also
// means a file that was NOT sorted keeps its order instead of being silently
// rearranged by this tool.

export const COLLAPSE_AGGREGATES = ['mean', 'max', 'min', 'first', 'last'];
export const COLLAPSE_DEFAULT_AGGREGATE = 'mean';

/** The aggregate names this kernel knows, with an unknown one falling back to the default. */
export function normalizeCollapseAggregate(aggregate) {
    return COLLAPSE_AGGREGATES.includes(aggregate) ? aggregate : COLLAPSE_DEFAULT_AGGREGATE;
}

/**
 * Where the runs of equal timestamps are.
 *
 * A non-finite stamp (NaT, a row whose time could not be read) never joins a
 * run: it cannot be said to be at the same instant as anything.
 *
 * @returns {{starts: Int32Array, lengths: Int32Array, groups: number, collapsed: number}}
 *   `collapsed` is how many rows the file would lose.
 */
export function timestampRuns(time) {
    const n = time?.length || 0;
    const starts = new Int32Array(n);
    const lengths = new Int32Array(n);
    let groups = 0;
    let i = 0;
    while (i < n) {
        const value = Number(time[i]);
        let end = i + 1;
        if (Number.isFinite(value)) {
            while (end < n && Number(time[end]) === value) end++;
        }
        starts[groups] = i;
        lengths[groups] = end - i;
        groups++;
        i = end;
    }
    return {
        starts: starts.subarray(0, groups),
        lengths: lengths.subarray(0, groups),
        groups,
        collapsed: n - groups,
    };
}

// mean/max/min are over the FINITE values of the run: a gap in one of the rows
// is a missing reading, not a reason to throw the burst away. A run with no
// finite value at all has nothing to average, and says so with NaN.
function aggregateRun(values, start, length, aggregate) {
    if (aggregate === 'first') return Number(values[start]);
    if (aggregate === 'last') return Number(values[start + length - 1]);
    let sum = 0;
    let count = 0;
    let max = -Infinity;
    let min = Infinity;
    for (let i = start; i < start + length; i++) {
        const value = Number(values[i]);
        if (!Number.isFinite(value)) continue;
        sum += value;
        count++;
        if (value > max) max = value;
        if (value < min) min = value;
    }
    if (!count) return NaN;
    if (aggregate === 'max') return max;
    if (aggregate === 'min') return min;
    return sum / count;
}

/**
 * One row per instant.
 *
 * @param {{time: ArrayLike<number>, columns: ArrayLike<number>[], params: {aggregate?: string}}} input
 * @returns {{time: Float64Array, columns: Float64Array[], groups: number, collapsed: number, aggregate: string}}
 */
export function runCollapseRepeats({ time, columns = [], params = {} } = {}) {
    const aggregate = normalizeCollapseAggregate(params.aggregate);
    const runs = timestampRuns(time || []);
    const out = new Float64Array(runs.groups);
    for (let g = 0; g < runs.groups; g++) out[g] = Number(time[runs.starts[g]]);
    const collapsedColumns = columns.map((values) => {
        const column = new Float64Array(runs.groups);
        for (let g = 0; g < runs.groups; g++) {
            column[g] = runs.lengths[g] === 1
                ? Number(values[runs.starts[g]])
                : aggregateRun(values, runs.starts[g], runs.lengths[g], aggregate);
        }
        return column;
    });
    return { time: out, columns: collapsedColumns, groups: runs.groups, collapsed: runs.collapsed, aggregate };
}

// ── A chunk at a time ──────────────────────────────────────────────────────

/**
 * runCollapseRepeats fed the rows a chunk at a time, giving one row per
 * instant as each run closes: what the chunked executor runs over a file too
 * large to hold (src/data/chunk-executor.js, runDatasetJob). A run may straddle
 * two chunks; it is carried open until a row with another stamp arrives, or
 * the series ends. The additions are made in the rows' order, as aggregateRun
 * makes them, so the doubles are the same.
 *
 *   const collapser = createCollapser({ aggregate: 'mean' }, { columns: 2 });
 *   for (const chunk of chunks) emit(collapser.push(chunk.x, [a, b]));
 *   emit(collapser.flush());
 *
 * `push(time, columns)` returns `{ t, columns }`, the runs closed by this
 * chunk; `flush()` the one still open. `report()` counts the rows read, the
 * groups written and the rows collapsed, as runCollapseRepeats does.
 */
export function createCollapser(params = {}, { columns = 1 } = {}) {
    const aggregate = normalizeCollapseAggregate(params.aggregate);
    // The open run, in place: one run at a time, so its accumulators are
    // allocated once and reset, never per row.
    let open = false;
    let stamp = NaN;
    let length = 0;
    const first = new Float64Array(columns);
    const last = new Float64Array(columns);
    const sum = new Float64Array(columns);
    const count = new Float64Array(columns);
    const max = new Float64Array(columns);
    const min = new Float64Array(columns);
    let rows = 0;
    let groups = 0;
    let done = false;

    // The run's accumulators read the row the way aggregateRun does, in order.
    const take = (values, i) => {
        for (let c = 0; c < columns; c++) {
            const value = Number(values[c][i]);
            last[c] = value;
            if (!Number.isFinite(value)) continue;
            sum[c] += value;
            count[c]++;
            if (value > max[c]) max[c] = value;
            if (value < min[c]) min[c] = value;
        }
    };
    const start = (t, values, i) => {
        open = true;
        stamp = t;
        length = 1;
        for (let c = 0; c < columns; c++) {
            first[c] = Number(values[c][i]);
            sum[c] = 0;
            count[c] = 0;
            max[c] = -Infinity;
            min[c] = Infinity;
        }
        take(values, i);
    };
    const close = (c) => {
        // A run of one row is that row, whatever it holds; a longer one is
        // aggregated over its finite values, NaN when there is none.
        if (length === 1) return first[c];
        if (aggregate === 'first') return first[c];
        if (aggregate === 'last') return last[c];
        if (!count[c]) return NaN;
        if (aggregate === 'max') return max[c];
        if (aggregate === 'min') return min[c];
        return sum[c] / count[c];
    };

    function feed(time, values, final) {
        const n = time?.length || 0;
        // At most one output per row read, and one for the run left open.
        const t = new Float64Array(n + 1);
        const outs = Array.from({ length: columns }, () => new Float64Array(n + 1));
        let k = 0;
        const emit = () => {
            t[k] = stamp;
            for (let c = 0; c < columns; c++) outs[c][k] = close(c);
            k++;
            groups++;
        };
        for (let i = 0; i < n; i++) {
            const value = Number(time[i]);
            rows++;
            // A finite stamp joins the open run when it is the same instant; a
            // non-finite one never joins anything (timestampRuns).
            if (open && Number.isFinite(stamp) && value === stamp) {
                length++;
                take(values, i);
                continue;
            }
            if (open) emit();
            start(value, values, i);
        }
        if (final && open) { emit(); open = false; }
        return { t: t.slice(0, k), columns: outs.map(column => column.slice(0, k)) };
    }

    return {
        push(time, values) {
            if (done) throw new Error('collapser: push after flush');
            return feed(time, values, false);
        },
        flush() {
            if (done) throw new Error('collapser: flush twice');
            done = true;
            return feed(null, null, true);
        },
        report: () => ({ aggregate, rows, groups, collapsed: rows - groups }),
    };
}
